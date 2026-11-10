import { afterEach, expect, test } from "bun:test";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { bash } from "./bash";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "./process_manager";
import { stopConversationBackground } from "./stop-conversation-background";

const child = { agentId: "agent-test", conversationId: "conv-child" };
const parent = { agentId: "agent-test", conversationId: "conv-parent" };

afterEach(async () => {
  setMessageQueueAdder(null);
  for (const [id, process] of backgroundProcesses) {
    process.completionNotificationSuppressed = true;
    process.terminate?.();
    process.process.kill("SIGKILL");
    await process.completion;
    clearBackgroundProcessCleanup(id);
  }
  backgroundProcesses.clear();
});

test("stopping a child's real background shell suppresses its wake and leaves its parent running", async () => {
  const notifications: QueuedMessage[] = [];
  setMessageQueueAdder((message) => notifications.push(message));
  await bash({
    command: "sleep 60",
    run_in_background: true,
    parentScope: child,
  });
  await bash({
    command: "sleep 60",
    run_in_background: true,
    parentScope: parent,
  });
  const childProcess = [...backgroundProcesses.values()].find(
    (process) => process.runtimeScope?.conversationId === child.conversationId,
  );
  const parentProcess = [...backgroundProcesses.values()].find(
    (process) => process.runtimeScope?.conversationId === parent.conversationId,
  );
  expect(childProcess).toBeDefined();
  expect(parentProcess).toBeDefined();
  await stopConversationBackground(child);
  await Bun.sleep(20);
  expect(childProcess?.status).toBe("failed");
  expect(childProcess?.completionNotificationSuppressed).toBe(true);
  expect(parentProcess?.status).toBe("running");
  expect(parentProcess?.completionNotificationSuppressed).toBeUndefined();
  expect(notifications).toEqual([]);
});
