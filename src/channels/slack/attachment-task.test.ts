import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChannelMessageAttachment } from "@/channels/types";
import {
  __resetBackgroundOutputDirForTests,
  backgroundProcesses,
} from "@/tools/impl/process_manager";
import { runSlackAttachmentDownloadTask } from "./attachment-task";

const ATTACHMENT: ChannelMessageAttachment = {
  id: "FLARGE",
  name: "archive.zip",
  mimeType: "application/zip",
  sizeBytes: 5,
  kind: "file",
  localPath: "/tmp/channels/slack/inbound/account-1/archive.zip",
};

beforeEach(() => {
  // Other suites exercise MessageChannel downloads and leave settled entries
  // in the shared registry; start each test from a clean slate.
  backgroundProcesses.clear();
});

afterEach(() => {
  backgroundProcesses.clear();
  __resetBackgroundOutputDirForTests();
});

test("fast downloads settle synchronously and complete the registry entry", async () => {
  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download: async () => ATTACHMENT,
  });

  expect(result).toEqual({ outcome: "completed", attachment: ATTACHMENT });
  const entries = [...backgroundProcesses.entries()];
  expect(entries).toHaveLength(1);
  const [taskId, entry] = entries[0] ?? [];
  expect(taskId).toMatch(/^download_\d+$/);
  expect(entry?.status).toBe("completed");
  expect(entry?.exitCode).toBe(0);
  expect(entry?.stdout.join("\n")).toContain(ATTACHMENT.localPath as string);
});

test("failed downloads report the error and fail the registry entry", async () => {
  const result = await runSlackAttachmentDownloadTask({
    description: "Slack attachment download FLARGE",
    download: async () => {
      throw new Error("HTTP 403");
    },
  });

  expect(result).toEqual({ outcome: "failed", error: "HTTP 403" });
  const entry = [...backgroundProcesses.values()][0];
  expect(entry?.status).toBe("failed");
  expect(entry?.exitCode).toBe(1);
  expect(entry?.stderr.join("\n")).toContain("HTTP 403");
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
  expect(settled?.stdout.join("\n")).toContain(ATTACHMENT.localPath as string);
  expect(readFileSync(settled?.outputFile as string, "utf-8")).toContain(
    ATTACHMENT.localPath as string,
  );
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
  expect(settled?.stderr.join("\n")).toContain("aborted");
});
