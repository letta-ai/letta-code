import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChannelMessageAttachment } from "@/channels/types";
import { killBackgroundProcess } from "@/tools/impl/kill-bash";
import {
  __resetBackgroundOutputDirForTests,
  backgroundProcesses,
} from "@/tools/impl/process_manager";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { runSlackAttachmentDownloadTask } from "./attachment-task";

const ATTACHMENT: ChannelMessageAttachment = {
  id: "FLARGE",
  name: "archive.zip",
  mimeType: "application/zip",
  sizeBytes: 5,
  kind: "file",
  localPath: "/tmp/channels/slack/inbound/account-1/archive.zip",
};
const RUNTIME_SCOPE = { agentId: "agent-1", conversationId: "conv-slack" };
let queued: QueuedMessage[] = [];

beforeEach(() => {
  // Other suites exercise MessageChannel downloads and leave settled entries
  // in the shared registry; start each test from a clean slate.
  backgroundProcesses.clear();
  queued = [];
  clearPendingMessages();
  setMessageQueueAdder((message) => {
    queued.push(message);
  });
});

afterEach(() => {
  setMessageQueueAdder(null);
  clearPendingMessages();
  backgroundProcesses.clear();
  __resetBackgroundOutputDirForTests();
});

test("fast downloads settle synchronously and complete the registry entry", async () => {
  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download: async () => ATTACHMENT,
    runtimeScope: RUNTIME_SCOPE,
  });

  expect(result).toEqual({ outcome: "completed", attachment: ATTACHMENT });
  const entries = [...backgroundProcesses.entries()];
  expect(entries).toHaveLength(1);
  const [taskId, entry] = entries[0] ?? [];
  expect(taskId).toMatch(/^download_\d+$/);
  expect(entry?.status).toBe("completed");
  expect(entry?.exitCode).toBe(0);
  expect(entry?.runtimeScope).toEqual(RUNTIME_SCOPE);
  expect(readFileSync(entry?.outputFile as string, "utf-8")).toContain(
    ATTACHMENT.localPath as string,
  );
  // The caller already has the result, so nothing else should wake the agent.
  expect(queued).toHaveLength(0);
});

test("failed downloads report the error and fail the registry entry", async () => {
  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download: async () => {
      throw new Error("HTTP 403");
    },
    runtimeScope: RUNTIME_SCOPE,
  });

  expect(result).toEqual({ outcome: "failed", error: "HTTP 403" });
  const entry = [...backgroundProcesses.values()][0];
  expect(entry?.status).toBe("failed");
  expect(entry?.exitCode).toBe(1);
  expect(readFileSync(entry?.outputFile as string, "utf-8")).toContain(
    "HTTP 403",
  );
});

test("slow downloads yield a background task id and finish afterwards", async () => {
  let resolveDownload: (attachment: ChannelMessageAttachment) => void = () => {
    throw new Error("download was never started");
  };
  const download = mock(
    (_signal: AbortSignal) =>
      new Promise<ChannelMessageAttachment>((resolve) => {
        resolveDownload = resolve;
      }),
  );

  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download,
    runtimeScope: RUNTIME_SCOPE,
    yieldTimeMs: 20,
  });

  if (result.outcome !== "backgrounded") {
    throw new Error(`Expected backgrounded outcome, got ${result.outcome}`);
  }
  expect(result.taskId).toMatch(/^download_\d+$/);

  const entry = backgroundProcesses.get(result.taskId);
  expect(entry?.status).toBe("running");

  resolveDownload(ATTACHMENT);
  await Bun.sleep(1);

  const settled = backgroundProcesses.get(result.taskId);
  expect(settled?.status).toBe("completed");
  expect(readFileSync(settled?.outputFile as string, "utf-8")).toContain(
    ATTACHMENT.localPath as string,
  );

  expect(queued).toHaveLength(1);
  const [notification] = queued;
  expect(notification?.kind).toBe("task_notification");
  expect(notification?.agentId).toBe(RUNTIME_SCOPE.agentId);
  expect(notification?.conversationId).toBe(RUNTIME_SCOPE.conversationId);
  expect(notification?.text).toContain(`<task-id>${result.taskId}</task-id>`);
  expect(notification?.text).toContain("<status>completed</status>");
  expect(notification?.text).toContain(ATTACHMENT.localPath as string);
  expect(notification?.text).toContain(result.outputFile);
});

test("slow download failures queue a failed task notification", async () => {
  let rejectDownload: (error: Error) => void = () => {
    throw new Error("download was never started");
  };
  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download: () =>
      new Promise<ChannelMessageAttachment>((_resolve, reject) => {
        rejectDownload = reject;
      }),
    runtimeScope: RUNTIME_SCOPE,
    yieldTimeMs: 20,
  });
  expect(result.outcome).toBe("backgrounded");

  rejectDownload(new Error("HTTP 500"));
  await Bun.sleep(1);

  expect(queued).toHaveLength(1);
  expect(queued[0]?.text).toContain("<status>failed</status>");
  expect(queued[0]?.text).toContain("HTTP 500");
});

test("TaskStop cancels a backgrounded download without a notification", async () => {
  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download: (signal) =>
      new Promise<ChannelMessageAttachment>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Slack attachment download was aborted.")),
          { once: true },
        );
      }),
    runtimeScope: RUNTIME_SCOPE,
    yieldTimeMs: 20,
  });
  if (result.outcome !== "backgrounded") {
    throw new Error(`Expected backgrounded outcome, got ${result.outcome}`);
  }

  expect(killBackgroundProcess(result.taskId)).toBe(true);
  await Bun.sleep(1);

  expect(queued).toHaveLength(0);
});

test("killing a backgrounded download aborts the transfer and fails the entry", async () => {
  let abortSeen = false;
  const download = (signal: AbortSignal) =>
    new Promise<ChannelMessageAttachment>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          abortSeen = true;
          reject(new Error("Slack attachment download was aborted."));
        },
        { once: true },
      );
    });

  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download,
    runtimeScope: RUNTIME_SCOPE,
    yieldTimeMs: 20,
  });

  if (result.outcome !== "backgrounded") {
    throw new Error(`Expected backgrounded outcome, got ${result.outcome}`);
  }

  const entry = backgroundProcesses.get(result.taskId);
  entry?.process.kill("SIGTERM");
  await Bun.sleep(1);

  expect(abortSeen).toBe(true);
  const settled = backgroundProcesses.get(result.taskId);
  expect(settled?.status).toBe("failed");
  expect(readFileSync(settled?.outputFile as string, "utf-8")).toContain(
    "aborted",
  );
});
