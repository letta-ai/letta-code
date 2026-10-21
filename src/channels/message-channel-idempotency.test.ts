import { describe, expect, mock, test } from "bun:test";
import { createSlackMessageActionAdapter } from "@/channels-slack";
import {
  executeMessageChannel,
  type MessageChannelExecutionResolver,
} from "@/gateway-core";
import type {
  ExternalToolCallRequestMessage,
  ExternalToolCallResult,
} from "@/types/app-server-protocol";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  makeStreamDelta,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";
import {
  createMessageChannelIdempotencyScope,
  MessageChannelDuplicateActionError,
  type MessageChannelIdempotencyScope,
} from "./message-channel-idempotency";
import type { ChannelMessageActionTransport } from "./plugin-types";

const SCOPE = { agentId: "agent-1", conversationId: "conv-1" };
const SEND = (chatId: string, message: string) => ({
  action: "send",
  channel: "slack",
  chat_id: chatId,
  message,
});

function createResolver(
  sendMessage: ReturnType<typeof mock>,
  opts: { errorString?: string; onHandleAction?: () => void } = {},
): MessageChannelExecutionResolver {
  const transport: ChannelMessageActionTransport = { sendMessage };
  return {
    isSupportedChannel: (c) => c === "slack",
    resolveRoutedContext: async ({ chatId }) => ({
      route: {
        accountId: "app-1",
        chatId,
        chatType: "channel",
        threadId: null,
        agentId: SCOPE.agentId,
        conversationId: SCOPE.conversationId,
      },
      transport,
      messageActions: opts.errorString
        ? {
            describeMessageTool: () => ({ actions: ["send"] }),
            handleAction: async () => {
              opts.onHandleAction?.();
              return opts.errorString ?? "Error:";
            },
          }
        : createSlackMessageActionAdapter({ react: true, uploadFile: true }),
    }),
    resolveProactiveContext: () => "Error: not used",
  };
}

function execOpts(
  resolver: MessageChannelExecutionResolver,
  scope: MessageChannelIdempotencyScope,
) {
  return { resolver, scope: SCOPE, idempotencyScope: scope };
}

describe("MessageChannel idempotency (executor)", () => {
  test("concurrent normalized sends suppress one call with agent-visible feedback", async () => {
    const sendMessage = mock(async () => ({ messageId: "m1" }));
    const resolver = createResolver(sendMessage);
    const scope = createMessageChannelIdempotencyScope();
    const o = execOpts(resolver, scope);
    const a = {
      action: "SEND",
      channel: "SLACK",
      chat_id: "channel:C123",
      message: "hi",
    };
    const b = {
      action: "send",
      channel: "slack",
      chat_id: "  C123  ",
      message: "hi",
    };

    const outcomes = await Promise.allSettled([
      executeMessageChannel(a, o),
      executeMessageChannel(b, o),
    ]);

    const fulfilled = outcomes.find(
      (outcome) => outcome.status === "fulfilled",
    );
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(fulfilled?.value).toBe("Message sent to slack (message_id: m1)");
    expect(rejected?.reason).toBeInstanceOf(MessageChannelDuplicateActionError);
    expect(String(rejected?.reason)).toContain("already in progress");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("different payloads and resolved destinations remain distinct", async () => {
    const sendMessage = mock(async () => ({ messageId: "m2" }));
    const resolver = createResolver(sendMessage);
    const o = execOpts(resolver, createMessageChannelIdempotencyScope());

    await executeMessageChannel(SEND("C123", "hello"), o);
    await executeMessageChannel(SEND("C123", "world"), o);
    await executeMessageChannel(SEND("C456", "hello"), o);

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("allows A-B-A while suppressing only an adjacent repeated send", async () => {
    const sendMessage = mock(async () => ({ messageId: "m-sequence" }));
    const resolver = createResolver(sendMessage);
    const o = execOpts(resolver, createMessageChannelIdempotencyScope());
    const a = SEND("C123", "A");
    const b = SEND("C123", "B");

    await executeMessageChannel(a, o);
    await expect(executeMessageChannel(a, o)).rejects.toThrow(
      "the immediately previous MessageChannel call already sent this exact text",
    );
    await executeMessageChannel(b, o);
    await executeMessageChannel(a, o);

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("ignores fields that do not affect a text send", async () => {
    const sendMessage = mock(async () => ({ messageId: "m-canonical" }));
    const resolver = createResolver(sendMessage);
    const o = execOpts(resolver, createMessageChannelIdempotencyScope());
    const input = SEND("C123", "same external message");

    await executeMessageChannel(input, o);
    await expect(
      executeMessageChannel(
        { ...input, messageId: "ignored", emoji: "ignored", remove: false },
        o,
      ),
    ).rejects.toBeInstanceOf(MessageChannelDuplicateActionError);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("does not suppress reversible reaction sequences", async () => {
    const sendMessage = mock(async () => ({ messageId: "m-reaction" }));
    const resolver = createResolver(sendMessage);
    const o = execOpts(resolver, createMessageChannelIdempotencyScope());
    const add = {
      action: "react",
      channel: "slack",
      chat_id: "C123",
      messageId: "target-1",
      emoji: "thumbsup",
    };

    await executeMessageChannel(add, o);
    await executeMessageChannel({ ...add, remove: true }, o);
    await executeMessageChannel(add, o);

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("a non-text action separates otherwise identical sends", async () => {
    const sendMessage = mock(async () => ({ messageId: "m-separated" }));
    const resolver = createResolver(sendMessage);
    const o = execOpts(resolver, createMessageChannelIdempotencyScope());
    const send = SEND("C123", "A");

    await executeMessageChannel(send, o);
    await executeMessageChannel(
      {
        action: "react",
        channel: "slack",
        chat_id: "C123",
        messageId: "target-1",
        emoji: "thumbsup",
      },
      o,
    );
    await executeMessageChannel(send, o);

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("does not suppress repeated uploads from a mutable local path", async () => {
    const sendMessage = mock(async () => ({ messageId: "m-upload" }));
    const resolver = createResolver(sendMessage);
    const o = execOpts(resolver, createMessageChannelIdempotencyScope());
    const upload = {
      action: "upload-file",
      channel: "slack",
      chat_id: "C123",
      message: "updated artifact",
      media: "/tmp/report.pdf",
    };

    await executeMessageChannel(upload, o);
    await executeMessageChannel(upload, o);

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("thrown result permits a later retry", async () => {
    let call = 0;
    const sendMessage = mock(async () => {
      call++;
      if (call === 1) throw new Error("boom");
      return { messageId: "m3" };
    });
    const o = execOpts(
      createResolver(sendMessage),
      createMessageChannelIdempotencyScope(),
    );
    const input = SEND("C123", "hi");

    const r1 = await executeMessageChannel(input, o);
    expect(r1).toBe("Error: Sending message to slack failed: boom");

    const r2 = await executeMessageChannel(input, o);
    expect(r2).toBe("Message sent to slack (message_id: m3)");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("Error: string result permits a later retry", async () => {
    const sendMessage = mock(async () => ({ messageId: "never" }));
    let actionCalls = 0;
    const resolver = createResolver(sendMessage, {
      errorString: "Error: refused",
      onHandleAction: () => {
        actionCalls++;
      },
    });
    const o = execOpts(resolver, createMessageChannelIdempotencyScope());
    const input = SEND("C123", "hi");

    expect(await executeMessageChannel(input, o)).toBe("Error: refused");
    expect(await executeMessageChannel(input, o)).toBe("Error: refused");
    expect(sendMessage).toHaveBeenCalledTimes(0);
    expect(actionCalls).toBe(2);
  });
});

describe("MessageChannel idempotency (gateway)", () => {
  function toolReq(
    id: string,
    input: Record<string, unknown>,
  ): ExternalToolCallRequestMessage {
    return {
      type: "external_tool_call_request",
      request_id: `ext-${id}`,
      runtime: TEST_RUNTIME,
      tool_call_id: id,
      tool_name: "MessageChannel",
      input,
    };
  }

  function setup(sendMessage: ReturnType<typeof mock>) {
    const client = new FakeClient();
    const results: ExternalToolCallResult[] = [];
    const resolver = createResolver(sendMessage);
    const { hooks } = makeHooks({
      executeExternalTool: async (req, _s, scope) => {
        const rt = req.runtime;
        if (!rt?.agent_id) throw new Error("agent runtime required");
        let result: ExternalToolCallResult;
        try {
          const text = await executeMessageChannel(req.input, {
            resolver,
            scope: {
              agentId: rt.agent_id,
              conversationId: rt.conversation_id,
            },
            idempotencyScope: scope,
          });
          result = {
            content: [{ type: "text", text }],
            is_error: text.startsWith("Error:"),
          };
        } catch (error) {
          result = {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            is_error: true,
          };
        }
        results.push(result);
        return result;
      },
    });
    return { gateway: new ChannelGateway(client, hooks), client, results };
  }

  test("distinct tool-call IDs dedupe in one active batch, then send again after terminal + new client_message_id", async () => {
    const sendMessage = mock(async () => ({ messageId: "m4" }));
    const { gateway, client, results } = setup(sendMessage);
    const source = makeSource({ channel: "slack", chatId: "C123" });
    const input = SEND("C123", "hello");

    await gateway.submit(
      makeDelivery({ sources: [source], clientMessageId: "cm-1" }),
    );
    client.emitExternalToolCall(toolReq("call-a", input));
    await Bun.sleep(10);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    client.emit(
      makeStreamDelta({
        message_type: "stop_reason",
        stop_reason: "requires_approval",
      }),
    );
    client.emitExternalToolCall(toolReq("call-b", input));
    await Bun.sleep(10);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    const first = results[0]?.content?.[0];
    const second = results[1]?.content?.[0];
    expect(first?.text).toBe("Message sent to slack (message_id: m4)");
    expect(results[0]?.is_error).toBe(false);
    expect(results[1]?.is_error).toBe(true);
    expect(second?.text).toContain(
      "Duplicate MessageChannel action suppressed",
    );

    client.emit(makeTurnFinished("end_turn"));
    await Bun.sleep(0);

    await gateway.submit(
      makeDelivery({ sources: [source], clientMessageId: "cm-2" }),
    );
    client.emitExternalToolCall(toolReq("call-c", input));
    await Bun.sleep(10);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    gateway.close();
  });

  test("process-owned calls without an active batch do not dedupe", async () => {
    const sendMessage = mock(async () => ({ messageId: "m5" }));
    const { gateway, client } = setup(sendMessage);
    const source = makeSource({ channel: "slack", chatId: "C123" });
    const input = SEND("C123", "hello");

    await gateway.registerRuntime(TEST_RUNTIME, [source]);
    client.emitExternalToolCall(toolReq("call-1", input));
    await Bun.sleep(10);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    client.emitExternalToolCall(toolReq("call-2", input));
    await Bun.sleep(10);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    gateway.close();
  });
});
