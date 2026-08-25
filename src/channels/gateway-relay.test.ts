import { expect, mock, spyOn, test } from "bun:test";
import type {
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
  StreamDeltaMessage,
  WsProtocolMessage,
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

class ApprovalRecoveryClient extends FakeClient {
  override async runtimeStart(
    options: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
  ): Promise<RuntimeStartResponseMessage> {
    this.emit({
      type: "control_request",
      request_id: "recovered-approval",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "pwd" },
        tool_call_id: "recovered-tool-call",
        permission_suggestions: [],
        blocked_path: null,
      },
      agent_id: TEST_RUNTIME.agent_id,
      conversation_id: TEST_RUNTIME.conversation_id,
    } as unknown as WsProtocolMessage);
    return await super.runtimeStart(options);
  }
}

function assistantDelta(options: {
  id: string;
  key: string;
  content: string | Array<{ type: "text"; text: string }>;
  otid?: string;
  subagentId?: string;
}): StreamDeltaMessage {
  return {
    ...makeStreamDelta({
      message_type: "assistant_message",
      id: options.id,
      ...(options.otid ? { otid: options.otid } : {}),
      content: options.content,
    }),
    idempotency_key: options.key,
    ...(options.subagentId ? { subagent_id: options.subagentId } : {}),
  };
}

test("relays all ordered assistant messages after approval resumes and the turn completes", async () => {
  const client = new FakeClient();
  const relays: string[] = [];
  const { hooks } = makeHooks({
    relayAssistantText: ({ text }) => {
      relays.push(text);
    },
  });
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery());
  const first = assistantDelta({
    id: "assistant-1",
    otid: "stable-1",
    key: "assistant-1a",
    content: "  First ",
  });
  client.emit(first);
  client.emit(first);
  client.emit(
    makeStreamDelta({
      message_type: "stop_reason",
      stop_reason: "requires_approval",
    }),
  );
  await Bun.sleep(0);
  expect(relays).toEqual([]);

  client.emit(
    assistantDelta({
      id: "assistant-1-retry-id",
      otid: "stable-1",
      key: "assistant-1b",
      content: "part  ",
    }),
  );
  client.emit(
    assistantDelta({
      id: "subagent-message",
      key: "subagent-message",
      content: "must not leak",
      subagentId: "subagent-1",
    }),
  );
  client.emit(
    assistantDelta({
      id: "assistant-2",
      key: "assistant-2",
      content: [{ type: "text", text: " Second " }],
    }),
  );
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(relays).toEqual(["First part Second"]);
  gateway.close();
});

test("tool_rule completion relays once and ignores duplicate or late terminal events", async () => {
  const client = new FakeClient();
  const relays: string[] = [];
  const { hooks } = makeHooks({
    relayAssistantText: ({ text }) => {
      relays.push(text);
    },
  });
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery());
  client.emit(
    assistantDelta({ id: "assistant-1", key: "assistant-1", content: "Done" }),
  );
  client.emit(makeTurnFinished("tool_rule"));
  client.emit(makeTurnFinished("tool_rule"));
  client.emit(
    assistantDelta({ id: "assistant-late", key: "late", content: "Late" }),
  );
  await Bun.sleep(0);

  expect(relays).toEqual(["Done"]);
  gateway.close();
});

test.each(["cancelled", "llm_api_error", "requires_approval"])(
  "does not relay a terminal %s turn",
  async (stopReason) => {
    const client = new FakeClient();
    const relay = mock(() => {});
    const { hooks } = makeHooks({ relayAssistantText: relay });
    const gateway = new ChannelGateway(client, hooks);

    await gateway.submit(makeDelivery());
    client.emit(
      assistantDelta({
        id: "assistant-1",
        key: "assistant-1",
        content: "Do not send",
      }),
    );
    client.emit(makeTurnFinished(stopReason));
    await Bun.sleep(0);

    expect(relay).not.toHaveBeenCalled();
    gateway.close();
  },
);

test("fails closed when one turn has multiple routed sources", async () => {
  const client = new FakeClient();
  const relay = mock(() => {});
  const { hooks } = makeHooks({ relayAssistantText: relay });
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(
    makeDelivery({
      sources: [makeSource(), makeSource({ chatId: "chat-2" })],
    }),
  );
  client.emit(
    assistantDelta({
      id: "assistant-1",
      key: "assistant-1",
      content: "Ambiguous",
    }),
  );
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(relay).not.toHaveBeenCalled();
  gateway.close();
});

test("fails closed after approval recovery because earlier text is unavailable", async () => {
  const client = new ApprovalRecoveryClient();
  const relay = mock(() => {});
  const { hooks } = makeHooks({ relayAssistantText: relay });
  const gateway = new ChannelGateway(client, hooks);
  const source = makeSource();

  expect(await gateway.restoreRuntime(TEST_RUNTIME, [source])).toEqual(
    new Set(["recovered-approval"]),
  );
  client.emit(
    assistantDelta({
      id: "assistant-after-recovery",
      key: "assistant-after-recovery",
      content: "Partial reply",
    }),
  );
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(relay).not.toHaveBeenCalled();
  gateway.close();
});

test("relay delivery failure does not hide the finished lifecycle event", async () => {
  const client = new FakeClient();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const { hooks, lifecycleEvents } = makeHooks({
    relayAssistantText: () => {
      throw new Error("transport failed");
    },
  });
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery());
  client.emit(
    assistantDelta({ id: "assistant-1", key: "assistant-1", content: "Reply" }),
  );
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(warn).toHaveBeenCalledWith(
    "[channels] Automatic relay failed: transport failed",
  );
  expect(lifecycleEvents.at(-1)).toMatchObject({
    type: "finished",
    outcome: "completed",
  });
  warn.mockRestore();
  gateway.close();
});
