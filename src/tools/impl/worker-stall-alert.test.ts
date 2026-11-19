import { afterEach, expect, jest, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import type { AppServerClient } from "@/app-server-client";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { backgroundTasks } from "./process_manager";
import { sendRemoteFollowUpWithReconnect } from "./remote-follow-up-retry";
import { spawnBackgroundSubagentTask } from "./task";
import {
  externalWorkerProgressListeners,
  recordRemoteTaskEvent,
} from "./task-transcript";
import { WORKER_STALL_INTERVAL_MS } from "./worker-stall-alert";

const scope = { agentId: "parent", conversationId: "parent-conversation" };
const advance = (ms = WORKER_STALL_INTERVAL_MS) => jest.advanceTimersByTime(ms);

afterEach(() => {
  for (const task of backgroundTasks.values()) task.abortController?.abort();
  backgroundTasks.clear();
  clearAllSubagents();
  jest.useRealTimers();
});

function launch(type: "codex" | "claude-code", notifyCaller = false) {
  jest.useFakeTimers();
  const messages: QueuedMessage[] = [];
  const worker = Promise.withResolvers<SubagentResult>();
  const completed = Promise.withResolvers<void>();
  const alerts = () =>
    messages.filter((message) =>
      message.text.includes("<status>running</status>"),
    );
  const { taskId, subagentId } = spawnBackgroundSubagentTask({
    subagentType: type,
    description: "Run tests",
    prompt: "Run tests",
    parentScope: scope,
    emitCompletionNotification: !notifyCaller,
    publishResult: notifyCaller,
    onComplete: () => completed.resolve(),
    deps: {
      spawnSubagentImpl: () => worker.promise,
      addToMessageQueueImpl: (message) => messages.push(message),
      copyGitHubPullRequestTagsImpl: async () => {},
      runSubagentStopHooksImpl: async () => ({
        blocked: false,
        errored: false,
        feedback: [],
        results: [],
      }),
    },
  });
  const task = backgroundTasks.get(taskId);
  return {
    alerts,
    completed: completed.promise,
    worker,
    taskId,
    subagentId,
    task,
  };
}

test("alerts the parent at 15 and 30 minutes without worker output", async () => {
  const { alerts, completed, taskId, worker } = launch("codex");
  advance(WORKER_STALL_INTERVAL_MS - 1);
  expect(alerts()).toHaveLength(0);
  advance(1);
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]).toMatchObject({ kind: "task_notification", ...scope });
  expect(alerts()[0]?.text).toContain(
    `${taskId} (codex) has produced no output`,
  );
  expect(alerts()[0]?.text).toContain("No worker events received yet");
  advance();
  expect(alerts()).toHaveLength(2);
  worker.resolve({ agentId: "", report: "Done", success: true });
  await completed;
  advance(3 * WORKER_STALL_INTERVAL_MS);
  expect(alerts()).toHaveLength(2);
});

test("new local output resets the silence interval and becomes the last event", async () => {
  const { alerts, completed, subagentId, worker } = launch("claude-code");
  advance();
  advance(WORKER_STALL_INTERVAL_MS - 1);
  externalWorkerProgressListeners(subagentId).onText("Checking tests");
  advance(1);
  expect(alerts()).toHaveLength(1);
  advance(WORKER_STALL_INTERVAL_MS - 1);
  expect(alerts()).toHaveLength(2);
  expect(alerts()[1]?.text).toContain("text: Checking tests");
  worker.reject(new Error("Worker failed"));
  await completed;
  advance();
  expect(alerts()).toHaveLength(2);
});

test("remote events reset the interval but replayed events do not", async () => {
  const { alerts, completed, subagentId, task, worker } = launch("codex");
  advance(WORKER_STALL_INTERVAL_MS - 1);
  const event = {
    seq: 1,
    at: "2026-01-01T00:00:00.000Z",
    type: "text",
    text: "Running tests",
  } as const;
  recordRemoteTaskEvent(subagentId, event);
  advance(WORKER_STALL_INTERVAL_MS - 1);
  expect(alerts()).toHaveLength(0);
  recordRemoteTaskEvent(subagentId, event);
  advance(1);
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]?.text).toContain(
    `Last event at ${event.at}: text: ${event.text}`,
  );
  task?.abortController?.abort();
  advance(3 * WORKER_STALL_INTERVAL_MS);
  expect(alerts()).toHaveLength(1);
  worker.resolve({ agentId: "", report: "", success: false });
  await completed;
});

test("a remote worker host leaves notifications to its caller", async () => {
  const { alerts, completed, worker } = launch("claude-code", true);
  advance(3 * WORKER_STALL_INTERVAL_MS);
  worker.resolve({ agentId: "", report: "Done", success: true });
  await completed;
  expect(alerts()).toHaveLength(0);
});

test("a remote follow-up timeout leaves the next stall alert scheduled", async () => {
  const { alerts, completed, worker } = launch("codex");
  advance();
  const command = {
    request_id: "steer-request",
    runtime: { agent_id: scope.agentId, conversation_id: scope.conversationId },
    agent_id: "codex_session",
    message: "Status?",
  };
  const client = {
    sendSubagentMessage: async () => {
      throw new Error(`Timed out waiting for ${command.request_id}`);
    },
  } as unknown as AppServerClient;
  await expect(
    sendRemoteFollowUpWithReconnect(
      client,
      command,
      async () => client,
      () => {},
      "worker-host",
    ),
  ).rejects.toThrow("didn't confirm the follow-up");
  advance();
  expect(alerts()).toHaveLength(2);
  worker.resolve({ agentId: "", report: "", success: true });
  await completed;
});
