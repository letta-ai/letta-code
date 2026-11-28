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
    onDeviceStatus: () => () => {},
    getDeviceStatus: async () => ({}),
    ready: async () => ({}),
    recoverPendingApprovals: async () => ({}),
    listMessages: async () => ({ messages: [] }),
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
  const pending = store.snapshot().approvals[0];
  if (!pending) throw new Error("Missing approval");
  store.decide(pending, { behavior: "allow" });
  expect(await decision).toEqual({ behavior: "allow" });
  await store.interrupt();
  expect(transport.abort).toHaveBeenCalledTimes(1);
  store.close();
  await reading;
});

test("reconnect replaces the session, denies stale approvals and rebases history", async () => {
  const first = connection();
  const second = connection();
  second.session.listMessages = async () => ({
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

test("default history includes its owning agent on the wire", async () => {
  const transport = connection();
  const requests: unknown[] = [];
  const session = Object.assign(transport.session, {
    conversationId: "default",
    agentId: "agent-example",
    sendCommand: async (command: unknown) => {
      requests.push(command);
      return {
        type: "conversation_messages_list_response",
        success: true,
        messages: [],
      };
    },
  });
  const store = new TerminalSession(() => session);
  const reading = store.connect();
  await Bun.sleep(0);
  expect(store.snapshot().status).toBe("online");
  expect(requests).toEqual([
    {
      type: "conversation_messages_list",
      conversation_id: "default",
      query: { agent_id: "agent-example", limit: 50, order: "desc" },
    },
  ]);
  store.close();
  await reading;
});

test("successive history windows keep older messages before the newest turn", async () => {
  const transport = connection();
  const messages = Array.from({ length: 53 }, (_, index) => ({
    id: `a-${index}`,
    message_type: "assistant_message",
    content: `row ${index}`,
  }));
  let end = 50;
  transport.session.listMessages = async () => ({
    messages: messages.slice(end - 50, end).reverse() as never,
  });
  const store = new TerminalSession(() => transport.session);
  const reading = store.connect();
  await Bun.sleep(0);
  end = 53;
  transport.push({
    type: "result",
    success: true,
    durationMs: 1,
    conversationId: "conv",
  });
  await Bun.sleep(0);
  expect(store.snapshot().rows.map((row) => row.uuid)).toEqual(
    messages.map((message) => message.id),
  );
  store.close();
  await reading;
});

test("a stale approval action cannot grant the next parallel request", async () => {
  const transport = connection();
  let approve!: CanUseToolCallback;
  const store = new TerminalSession((callback) => {
    approve = callback;
    return transport.session;
  });
  const reading = store.connect();
  await Bun.sleep(0);
  const first = approve("Edit", { file_path: "a" });
  const second = approve("Write", { file_path: "b" });
  const [a, b] = store.snapshot().approvals;
  if (!a || !b) throw new Error("Expected both requests");
  store.decide(a, { behavior: "deny", message: "Keep the original" });
  store.decide(a, { behavior: "allow", updatedPermissions: ["save-default"] });
  expect(store.snapshot().approvals).toEqual([b]);
  store.decide(b, { behavior: "allow", updatedPermissions: ["save-default"] });
  expect(await first).toEqual({
    behavior: "deny",
    message: "Keep the original",
  });
  expect(await second).toEqual({
    behavior: "allow",
    updatedPermissions: ["save-default"],
  });
  store.close();
  await reading;
});

test("a failed interrupt can be retried without dropping queued messages", async () => {
  const transport = connection();
  transport.abort.mockRejectedValueOnce(new Error("Cancel failed"));
  const store = new TerminalSession(() => transport.session);
  const reading = store.connect();
  await Bun.sleep(0);
  transport.push({
    type: "queue_update",
    queue: [
      {
        id: "next",
        clientMessageId: "next",
        kind: "message",
        source: "user",
        content: "next",
        enqueuedAt: "now",
      },
    ],
  });
  await Bun.sleep(0);
  await store.interrupt();
  expect(store.snapshot().error).toBe("Cancel failed");
  await store.interrupt();
  expect(store.snapshot().activity).toBe("Interrupt requested");
  expect(store.snapshot().queue.map((item) => item.id)).toEqual(["next"]);
  store.close();
  await reading;
});

test("turn and subagent frames from another runtime or an older snapshot cannot replace device state", async () => {
  const transport = connection();
  Object.assign(transport.session, {
    agentId: "agent-a",
    conversationId: "conv-a",
  });
  const store = new TerminalSession(() => transport.session);
  const reading = store.connect();
  await Bun.sleep(0);
  const event = {
    runtime: { agent_id: "agent-a", conversation_id: "conv-a" },
    type: "update_subagent_state",
    event_seq: 12,
    subagents: [
      {
        subagent_id: "child",
        description: "Checking files",
        status: "running",
      },
    ],
  };
  store.receiveRuntimeEvent(event);
  store.receiveRuntimeEvent({ ...event, event_seq: 11, subagents: [] });
  store.receiveRuntimeEvent({
    ...event,
    event_seq: 22,
    runtime: { agent_id: "agent-b", conversation_id: "conv-a" },
    subagents: [],
  });
  expect(store.snapshot().subagents).toEqual([
    { id: "child", description: "Checking files", status: "running" },
  ]);
  store.receiveRuntimeEvent({
    ...event,
    type: "turn_finished",
    event_seq: 13,
    usage: { total_tokens: 77 },
  });
  expect(store.snapshot().tokens).toBe(77);
  store.close();
  await reading;
});

test("replayed nonblocking questions send only one answer while the turn continues", async () => {
  const transport = connection();
  const store = new TerminalSession(() => transport.session);
  const reading = store.connect();
  await Bun.sleep(0);
  const questions = [
    {
      question: "Proceed?",
      header: "Plan",
      options: [
        { label: "Yes", description: "Run" },
        { label: "No", description: "Revise" },
      ],
    },
  ];
  transport.push({
    type: "tool_call",
    uuid: "call",
    toolName: "AskUserQuestion",
    toolCallId: "q",
    toolInput: { questions },
  });
  const result = {
    type: "tool_result" as const,
    uuid: "result",
    toolCallId: "q",
    isError: false,
    content: JSON.stringify({
      type: "ask_user_question",
      version: 2,
      toolCallId: "q",
      questions,
    }),
  };
  transport.push(result);
  await Bun.sleep(0);
  const question = store.snapshot().question;
  if (!question) throw new Error("Missing question");
  await Promise.all([
    store.answer(question, { "Proceed?": "Yes" }),
    store.answer(question),
  ]);
  transport.push(result);
  await Bun.sleep(0);
  expect(store.snapshot().question).toBeUndefined();
  expect(transport.send).toHaveBeenCalledTimes(1);
  expect(transport.send.mock.calls[0]?.[0]).toContain(
    "ask-user-question-response",
  );
  store.close();
  await reading;
});
