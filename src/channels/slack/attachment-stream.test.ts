import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  SlackAttachmentDownloadError,
  saveSlackAttachmentStream,
} from "./attachment-stream";

let channelsRoot: string | null = null;

beforeEach(async () => {
  channelsRoot = await mkdtemp(join(tmpdir(), "letta-slack-stream-"));
  __testOverrideChannelsRoot(channelsRoot);
});

afterEach(async () => {
  __testOverrideChannelsRoot(null);
  if (channelsRoot) {
    await rm(channelsRoot, { recursive: true, force: true });
    channelsRoot = null;
  }
});

async function listInboundFiles(): Promise<string[]> {
  if (!channelsRoot) {
    throw new Error("Expected Slack stream test root");
  }
  const inboundDir = join(channelsRoot, "slack", "inbound", "account-1");
  return await readdir(inboundDir);
}

test("a stalled stream fails with a read-idle timeout and removes the partial file", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      // Never enqueue again and never close: a dead TCP stream.
    },
  });

  await expect(
    saveSlackAttachmentStream({
      accountId: "account-1",
      fileName: "archive.zip",
      body,
      readIdleTimeoutMs: 25,
    }),
  ).rejects.toMatchObject({
    name: "SlackAttachmentDownloadError",
    reason: "download_failed",
    message: expect.stringContaining("stalled"),
  });
  expect(await listInboundFiles()).toEqual([]);
});

test("aborting the signal fails the stream and removes the partial file", async () => {
  const abortController = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
  });

  const savePromise = saveSlackAttachmentStream({
    accountId: "account-1",
    fileName: "archive.zip",
    body,
    signal: abortController.signal,
  });
  abortController.abort();

  await expect(savePromise).rejects.toMatchObject({
    name: "SlackAttachmentDownloadError",
    reason: "download_failed",
    message: expect.stringContaining("aborted"),
  });
  expect(await listInboundFiles()).toEqual([]);
});

test("a healthy stream still saves within the idle window", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  });

  const saved = await saveSlackAttachmentStream({
    accountId: "account-1",
    fileName: "archive.zip",
    body,
    readIdleTimeoutMs: 25,
  });

  expect(saved.sizeBytes).toBe(5);
  expect(saved.localPath.endsWith("archive.zip")).toBe(true);
  expect(await listInboundFiles()).toHaveLength(1);
});

test("SlackAttachmentDownloadError keeps its reason across the stream seam", () => {
  const error = new SlackAttachmentDownloadError(
    "download_failed",
    "Slack attachment download stalled (no data received for 25ms).",
  );
  expect(error.reason).toBe("download_failed");
});
