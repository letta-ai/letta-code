import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getChannelDir } from "@/channels/config";

export type SlackAttachmentDownloadFailureReason =
  | "exceeds_auto_download_limit"
  | "missing_download_url"
  | "download_failed";

export class SlackAttachmentDownloadError extends Error {
  constructor(
    readonly reason: SlackAttachmentDownloadFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "SlackAttachmentDownloadError";
  }
}

function sanitizeFileName(name: string): string {
  const normalized = name.trim().replace(/[^\w.-]+/g, "_");
  return normalized.length > 0 ? normalized : "attachment";
}

/**
 * Slack file downloads must never wedge a turn on a dead TCP stream: a read
 * that produces no data within this window fails the download instead of
 * waiting forever. Mirrors OpenClaw's Slack media read-idle timeout.
 */
export const SLACK_ATTACHMENT_READ_IDLE_TIMEOUT_MS = 60_000;

async function readWithIdleTimeout(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  idleTimeoutMs: number,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal?.aborted) {
    throw new SlackAttachmentDownloadError(
      "download_failed",
      "Slack attachment download was aborted.",
    );
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<{ done: boolean; value?: Uint8Array }>(
      (resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new SlackAttachmentDownloadError(
              "download_failed",
              `Slack attachment download stalled (no data received for ${idleTimeoutMs}ms).`,
            ),
          );
        }, idleTimeoutMs);
        if (signal) {
          onAbort = () =>
            reject(
              new SlackAttachmentDownloadError(
                "download_failed",
                "Slack attachment download was aborted.",
              ),
            );
          signal.addEventListener("abort", onAbort, { once: true });
        }
        reader.read().then(resolve, reject);
      },
    );
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function saveSlackAttachmentStream(params: {
  accountId: string;
  fileName: string;
  body: ReadableStream<Uint8Array>;
  maxBytes?: number;
  signal?: AbortSignal;
  readIdleTimeoutMs?: number;
}): Promise<{ localPath: string; sizeBytes: number }> {
  const inboundDir = join(
    getChannelDir("slack"),
    "inbound",
    sanitizeFileName(params.accountId),
  );
  await mkdir(inboundDir, { recursive: true });

  const filePath = join(
    inboundDir,
    `${Date.now()}-${randomUUID()}-${sanitizeFileName(params.fileName)}`,
  );
  const temporaryPath = `${filePath}.partial`;
  const fileHandle = await open(temporaryPath, "wx");
  const reader = params.body.getReader();
  const readIdleTimeoutMs =
    params.readIdleTimeoutMs ?? SLACK_ATTACHMENT_READ_IDLE_TIMEOUT_MS;
  let sizeBytes = 0;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(
        reader,
        readIdleTimeoutMs,
        params.signal,
      );
      if (done) {
        break;
      }
      if (!value?.byteLength) {
        continue;
      }
      sizeBytes += value.byteLength;
      if (params.maxBytes !== undefined && sizeBytes > params.maxBytes) {
        throw new SlackAttachmentDownloadError(
          "exceeds_auto_download_limit",
          `Slack attachment exceeds automatic download limit (${params.maxBytes} bytes).`,
        );
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await fileHandle.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten <= 0) {
          throw new Error("Slack attachment write made no progress.");
        }
        offset += bytesWritten;
      }
    }
    completed = true;
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {}
    await fileHandle.close().catch(() => undefined);
    if (!completed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { localPath: filePath, sizeBytes };
}
