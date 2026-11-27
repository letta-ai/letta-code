import { expect, mock, test } from "bun:test";
import type {
  CanUseToolCallback,
  LettaCodeSession,
  SDKMessage,
} from "@letta-ai/letta-agent-sdk";
import { TerminalSession } from "./terminal-session";

function connection() {
  let controller!: ReadableStreamDefaultController<SDKMessage>;
  const messages = new ReadableStream<SDKMessage>({
    start(stream) {
      controller = stream;
    },
  });
  const send = mock(async (_text: string, _options: { otid: string }) => {});
  const abort = mock(async () => {});
  const session = {
    bootstrapState: async () => ({ messages: [] }),
    stream: () => messages.values(),
    send,
    abort,
    close: () => controller.close(),
  };
  return {
    session: session as unknown as LettaCodeSession,
    send,
    abort,
    push: (message: SDKMessage) => controller.enqueue(message),
  };
}

test("reconciles input by otid, ignores replay, and delegates queue, approval and interrupt", async () => {
  const transport = connection();
  let approve!: CanUseToolCallback;
  const store = new TerminalSession((callback) => {
    approve = callback;
    return transport.session;
  });
  const reading = store.connect();
  await Bun.sleep(0);
  await store.send("Hello");
  const otid = transport.send.mock.calls[0]?.[1].otid;
  expect(store.snapshot().rows[0]).toMatchObject({ otid });

  const delta: SDKMessage = {
    type: "assistant",
    uuid: "a",
    content: "Hi",
    runId: "r",
    seqId: 1,
  };
  transport.push(delta);
  transport.push(delta);
  transport.push({
    type: "queue_update",
    queue: [
      {
        id: "q",
        clientMessageId: "client",
        kind: "message",
        source: "user",
        content: "Next",
        enqueuedAt: "now",
      },
    ],
  });
  await Bun.sleep(0);
  expect(store.snapshot().rows.map((row) => row.kind)).toEqual([
    "user",
    "assistant",
  ]);
  expect(store.snapshot().rows[1]).toMatchObject({ text: "Hi" });
  transport.session.listMessages = async () => ({
    messages: [
      {
        id: "u",
        message_type: "user_message",
        content: "Hello",
        otid,
      } as never,
    ],
  });
  transport.push({
    type: "result",
    success: true,
    durationMs: 1,
    conversationId: "conv",
  });
  await Bun.sleep(0);
  expect(
    store.snapshot().rows.filter((row) => row.kind === "user"),
  ).toHaveLength(1);
  expect(store.snapshot().rows[0]?.uuid).toBe("u");
  expect(store.snapshot().queue[0]?.id).toBe("q");
  const decision = approve("Edit", { file: "demo" });
  expect(store.snapshot().approvals[0]?.name).toBe("Edit");
  store.decide(true);
  expect(await decision).toEqual({ behavior: "allow" });
  await store.interrupt();
  expect(transport.abort).toHaveBeenCalledTimes(1);
  store.close();
  await reading;
});

test("reconnect replaces the session, denies stale approvals and rebases history", async () => {
  const first = connection();
  const second = connection();
  second.session.bootstrapState = async () => ({
    agentId: "agent",
    conversationId: "conv",
    model: undefined,
    messages: [
      {
        id: "a",
        message_type: "assistant_message",
        content: "restored",
      } as never,
    ],
  });
  let approve!: CanUseToolCallback;
  const sessions = [first.session, second.session];
  const store = new TerminalSession((callback) => {
    approve = callback;
    return sessions.shift()!;
  });
  const reading = store.connect();
  await Bun.sleep(0);
  const stale = approve("Edit", {});
  const reopened = store.connect();
  await Bun.sleep(0);
  expect(await stale).toMatchObject({ behavior: "deny" });
  expect(store.snapshot().rows).toHaveLength(1);
  expect(store.snapshot().rows[0]).toMatchObject({ text: "restored" });
  store.close();
  await Promise.all([reading, reopened]);
});
