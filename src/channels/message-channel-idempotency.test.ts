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
import type { MessageChannelIdempotencyScope } from "./message-channel-executor";
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
        : createSlackMessageActionAdapter({ react: true }),
    }),
    resolveProactiveContext: () => "Error: not used",
  };
}

function createScope(): MessageChannelIdempotencyScope {
  const entries = new Map<string, Promise<string>>();
  return {
    async execute(key, effect) {
      const existing = entries.get(key);
      if (existing) return existing;
      const pending = effect();
      entries.set(key, pending);
      try {
        const result = await pending;
        if (result.startsWith("Error:")) entries.delete(key);
        return result;
      } catch (error) {
        entries.delete(key);
        throw error;
      }
    },
  };
}

function execOpts(
  resolver: MessageChannelExecutionResolver,
  scope: MessageChannelIdempotencyScope,
) {
  return { resolver, scope: SCOPE, idempotencyScope: scope };
}

describe("MessageChannel idempotency (executor)", () => {
  test("concurrent normalized sends coalesce", async () => {
    const sendMessage = mock(async () => ({ messageId: "m1" }));
    const resolver = createResolver(sendMessage);
    const scope = createScope();
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

    const [r1, r2] = await Promise.all([
      executeMessageChannel(a, o),
      executeMessageChannel(b, o),
    ]);

    expect(r1).toBe("Message sent to slack (message_id: m1)");
    expect(r2).toBe(r1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("different payloads and resolved destinations remain distinct", async () => {
    const sendMessage = mock(async () => ({ messageId: "m2" }));
    const resolver = createResolver(sendMessage);
    const o = execOpts(resolver, createScope());

    await executeMessageChannel(SEND("C123", "hello"), o);
    await executeMessageChannel(SEND("C123", "world"), o);
    await executeMessageChannel(SEND("C456", "hello"), o);

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("thrown result permits a later retry", async () => {
    let call = 0;
    const sendMessage = mock(async () => {
      call++;
      if (call === 1) throw new Error("boom");
      return { messageId: "m3" };
    });
    const o = execOpts(createResolver(sendMessage), createScope());
    const input = SEND("C123", "hi");

    const r1 = await executeMessageChannel(input, o);
    expect(r1).toContain("Error sending message to slack");

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
    const o = execOpts(resolver, createScope());
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
        if (!rt) throw new Error("runtime required");
        const text = await executeMessageChannel(req.input, {
          resolver,
          scope: { agentId: rt.agent_id, conversationId: rt.conversation_id },
          idempotencyScope: scope,
        });
        const result: ExternalToolCallResult = {
          content: [{ type: "text", text }],
        };
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
    expect(second?.text).toBe(first?.text);

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
