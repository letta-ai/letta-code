import { expect, mock, test } from "bun:test";
import {
  createSlackTurnSource,
  createStartedSlackAdapter,
  FakeSlackApp,
  FakeSlackWriteClient,
  getSlackWriteClient,
  installSlackAdapterTestHooks,
} from "./adapter-test-harness";

installSlackAdapterTestHooks();

test("slack status event table: flat mention queues a pinned thinking status", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource({
    messageId: "1712800000.000100",
    threadId: "1712800000.000100",
  });

  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });

  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "is thinking...",
    loading_messages: ["is thinking..."],
  });
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack status event table: established turns stay quiet and clear a stale ghost once", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });

  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "",
  });
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack status event table: concrete descriptions replace in place and generic updates do nothing", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Inspecting the Slack adapter",
    sources: [source],
  });
  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "is working...",
    loading_messages: ["Inspecting the Slack adapter"],
  });

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "thinking",
    state: "updated",
    message: "Thinking",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Preparing tool: exec_command",
    toolName: "exec_command",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Preparing tool: Read",
    toolName: "Read",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "completed",
    message: "Tool finished",
    toolName: "Bash",
    toolDetails: "Inspecting the Slack adapter",
    sources: [source],
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Running focused tests",
    sources: [source],
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({
      loading_messages: ["Running focused tests"],
    }),
  );
});

test("slack status event table: concurrent title swaps are sent in event order", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const sentTitles: string[] = [];
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  FakeSlackWriteClient.setStatusHandler = async (args) => {
    sentTitles.push((args.loading_messages as string[])[0] ?? "");
    if (sentTitles.length === 1) {
      markFirstStarted?.();
      await firstWriteGate;
    }
    return { ok: true };
  };

  const firstUpdate = adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Reading the adapter",
    sources: [source],
  });
  await firstStarted;
  const secondUpdate = adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Running the tests",
    sources: [source],
  });

  await Promise.resolve();
  expect(sentTitles).toEqual(["Reading the adapter"]);
  releaseFirstWrite?.();
  await Promise.all([firstUpdate, secondUpdate]);
  expect(sentTitles).toEqual(["Reading the adapter", "Running the tests"]);
});

test("slack status event table: queued mid-turn input does not clear live status", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Working through the turn",
    sources: [source],
  });

  const client = getSlackWriteClient();
  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: { ...source, messageId: "1712800000.000300" },
  });

  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack status event table: flat-channel activity remains status-only", async () => {
  const source = createSlackTurnSource({
    messageId: "1712800000.000100",
    threadId: "1712800000.000100",
  });
  const adapter = await createStartedSlackAdapter();
  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Reading the implementation",
    sources: [source],
  });

  const client = getSlackWriteClient();
  expect(client.chat.postMessage).not.toHaveBeenCalled();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "is working...",
      loading_messages: ["Reading the implementation"],
    }),
  );
});

test("slack status event table: reactions keep status active while messages make it non-sticky", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const progress = {
    type: "progress" as const,
    kind: "tool" as const,
    state: "started" as const,
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Waiting on a long command",
    sources: [source],
  };
  await adapter.handleTurnProgressEvent?.(progress);
  const client = getSlackWriteClient();

  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "",
    reaction: "eyes",
    targetMessageId: "1712800000.000200",
    agentId: "agent-1",
    conversationId: "conv-1",
  });
  expect(client.reactions.add).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);

  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "A durable reply",
    threadId: "1712800000.000100",
    agentId: "agent-1",
    conversationId: "conv-1",
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);

  await adapter.handleTurnProgressEvent?.(progress);
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
});

test("slack terminal table: end_turn and cancelled clear without posting", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const clientProgress = {
    type: "progress" as const,
    kind: "tool" as const,
    state: "started" as const,
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Doing work",
    sources: [source],
  };

  await adapter.handleTurnProgressEvent?.(clientProgress);
  const client = getSlackWriteClient();
  client.assistant.threads.setStatus.mockClear();
  client.chat.postMessage.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
    stopReason: "end_turn",
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "",
  });
  expect(client.chat.postMessage).not.toHaveBeenCalled();

  await adapter.handleTurnProgressEvent?.(clientProgress);
  client.assistant.threads.setStatus.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-2",
    sources: [source],
    outcome: "cancelled",
    stopReason: "cancelled",
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack terminal table: fatal stops post one quiet error with a web footnote", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Doing work",
    sources: [source],
  });
  const client = getSlackWriteClient();
  client.assistant.threads.setStatus.mockClear();
  client.chat.postMessage.mockClear();

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "error",
    stopReason: "llm_api_error",
    error: "Provider request failed.",
    runId: "run-1",
  });

  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{
      text: string;
      blocks?: Array<{
        type: string;
        text?: string;
        elements?: Array<{ text: string }>;
      }>;
    }>
  >;
  const call = postCalls[0]?.[0] as {
    text: string;
    blocks?: Array<{
      type: string;
      text?: string;
      elements?: Array<{ text: string }>;
    }>;
  };
  expect(call.text).toBe("Provider request failed.");
  expect(call.text).not.toContain("Turn failed");
  expect(call.text).not.toContain("```");
  expect(call.blocks?.[0]).toEqual({
    type: "markdown",
    text: "Provider request failed.",
  });
  expect(call.blocks?.at(-1)?.elements?.[0]?.text).toBe(
    "<https://chat.letta.com/chat/agent-1?conversation=conv-1|View on web>",
  );
});

test("slack terminal table: tool_rule is quiet, no_tool_call is fatal, and approval is non-terminal", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
    stopReason: "tool_rule",
  });
  const client = getSlackWriteClient();
  expect(client.chat.postMessage).not.toHaveBeenCalled();

  client.assistant.threads.setStatus.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-2",
    sources: [source],
    outcome: "error",
    stopReason: "no_tool_call",
  });
  expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{ text: string }>
  >;
  expect(postCalls[0]?.[0]?.text).toBe(
    "Something went wrong while processing that message. Please try again.",
  );

  client.assistant.threads.setStatus.mockClear();
  client.chat.postMessage.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-3",
    sources: [source],
    outcome: "error",
    stopReason: "requires_approval",
  });
  expect(client.assistant.threads.setStatus).not.toHaveBeenCalled();
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack approval widget forwards the click and replaces its buttons with the decision", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const onControlResponse = mock(async (): Promise<"handled"> => "handled");
  adapter.onControlResponse = onControlResponse;

  await adapter.handleControlRequestEvent?.({
    requestId: "request-1",
    kind: "generic_tool_approval",
    source,
    toolName: "Bash",
    input: { command: "bun test" },
  });

  const client = getSlackWriteClient();
  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{
      blocks?: Array<{
        type: string;
        elements?: Array<{ value?: string; text?: { text: string } }>;
      }>;
    }>
  >;
  const actions = postCalls[0]?.[0]?.blocks?.find(
    (block) => block.type === "actions",
  );
  expect(actions?.elements?.map((element) => element.text?.text)).toEqual([
    "Approve",
    "Deny",
  ]);
  const approveValue = actions?.elements?.[0]?.value;
  expect(approveValue).toBeString();

  const app = FakeSlackApp.instances[0];
  const handler = app?.actionHandlers.get("letta_channel_approval");
  const ack = mock(async () => {});
  await handler?.({
    body: { user: { id: "U123", name: "Sarah" } },
    action: { value: approveValue },
    ack,
  });

  expect(ack).toHaveBeenCalledTimes(1);
  expect(onControlResponse).toHaveBeenCalledWith({
    requestId: "request-1",
    senderId: "U123",
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    threadId: "1712800000.000100",
    response: {
      request_id: "request-1",
      decision: { behavior: "allow" },
    },
  });
  expect(client.chat.update).toHaveBeenCalledTimes(1);
  expect(client.chat.update).toHaveBeenLastCalledWith({
    channel: "C123",
    ts: "1712800000.000100",
    text: "Approved by <@U123>.",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Approved by <@U123>." },
      },
    ],
  });
});

test("slack approval widget retires both stale and re-posted recovery prompts", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const onControlResponse = mock(async (): Promise<"handled"> => "handled");
  adapter.onControlResponse = onControlResponse;
  const event = {
    requestId: "request-recovered",
    kind: "generic_tool_approval" as const,
    source,
    toolName: "Bash",
    input: { command: "bun test" },
  };

  await adapter.handleControlRequestEvent?.(event);
  const client = getSlackWriteClient();
  client.chat.postMessage.mockResolvedValueOnce({
    ts: "1712800000.000400",
  });
  await adapter.handleControlRequestEvent?.(event);

  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{
      blocks?: Array<{
        type: string;
        elements?: Array<{ value?: string }>;
      }>;
    }>
  >;
  const approveValue = postCalls[0]?.[0]?.blocks?.find(
    (block) => block.type === "actions",
  )?.elements?.[0]?.value;
  const handler = FakeSlackApp.instances[0]?.actionHandlers.get(
    "letta_channel_approval",
  );

  await handler?.({
    body: {
      user: { id: "U123", name: "Sarah" },
      channel: { id: "C123" },
      message: {
        ts: "1712800000.000100",
        thread_ts: "1712800000.000100",
      },
    },
    action: { value: approveValue },
    ack: async () => {},
  });

  expect(onControlResponse).toHaveBeenCalledTimes(1);
  expect(client.chat.update).toHaveBeenCalledTimes(2);
  for (const ts of ["1712800000.000100", "1712800000.000400"]) {
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts,
        text: "Approved by <@U123>.",
      }),
    );
  }
});

test("slack progress never calls a stream API and ignores MessageChannel progress", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Preparing tool: MessageChannel",
    toolName: "MessageChannel",
    toolDetails: "Sending a reply",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Checking the implementation",
    sources: [source],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
    stopReason: "end_turn",
  });

  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
  expect(client.chat.startStream).not.toHaveBeenCalled();
  expect(client.chat.appendStream).not.toHaveBeenCalled();
  expect(client.chat.stopStream).not.toHaveBeenCalled();
});
