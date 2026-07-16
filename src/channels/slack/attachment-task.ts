import type { ChannelMessageAttachment } from "@/channels/types";
import {
  appendBackgroundProcessOutput,
  appendToOutputFile,
  assertBackgroundProcessCapacity,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextDownloadId,
  scheduleBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";

/**
 * How long an explicit Slack attachment download may run inside the tool call
 * before it yields to a background task. Mirrors the Codex-toolset
 * exec_command yield pattern: fast downloads stay a single round-trip, slow
 * ones return a task id instead of wedging the turn on MessageChannel.
 */
export const SLACK_ATTACHMENT_DOWNLOAD_YIELD_MS = 10_000;

export type SlackAttachmentDownloadOutcome =
  | { outcome: "completed"; attachment: ChannelMessageAttachment }
  | { outcome: "failed"; error: string }
  | { outcome: "backgrounded"; taskId: string };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a Slack attachment download with a bounded synchronous window.
 *
 * The download is registered in the shared background-process registry up
 * front so TaskOutput/TaskStop and the listener status snapshot see it from
 * the first byte. If it settles within the yield window the entry completes
 * immediately and the caller gets the direct result; otherwise the caller
 * gets the task id while the transfer keeps streaming in-process.
 */
export async function runSlackAttachmentDownloadTask(params: {
  description: string;
  download: (signal: AbortSignal) => Promise<ChannelMessageAttachment>;
  yieldTimeMs?: number;
}): Promise<SlackAttachmentDownloadOutcome> {
  assertBackgroundProcessCapacity();

  const taskId = getNextDownloadId();
  const outputFile = createBackgroundOutputFile(taskId);
  const abortController = new AbortController();
  const processState = {
    process: {
      kill: () => {
        abortController.abort();
        return true;
      },
    },
    command: params.description,
    stdout: [] as string[],
    stderr: [] as string[],
    status: "running" as "running" | "completed" | "failed",
    exitCode: null as number | null,
    lastReadIndex: { stdout: 0, stderr: 0 },
    startTime: new Date(),
    outputFile,
    totalStdoutLines: 0,
    totalStderrLines: 0,
  };
  backgroundProcesses.set(taskId, processState);
  appendToOutputFile(outputFile, `${params.description}\n`);

  const downloadPromise = params
    .download(abortController.signal)
    .then((attachment) => {
      const line = `Slack attachment downloaded (local_path: ${attachment.localPath})`;
      processState.status = "completed";
      processState.exitCode = 0;
      appendBackgroundProcessOutput(processState, "stdout", line);
      appendToOutputFile(outputFile, `${line}\n`);
      scheduleBackgroundProcessCleanup(taskId);
      return { outcome: "completed" as const, attachment };
    })
    .catch((error: unknown) => {
      const message = toErrorMessage(error);
      processState.status = "failed";
      processState.exitCode = 1;
      appendBackgroundProcessOutput(
        processState,
        "stderr",
        `Slack attachment download failed: ${message}`,
      );
      appendToOutputFile(
        outputFile,
        `Slack attachment download failed: ${message}\n`,
      );
      scheduleBackgroundProcessCleanup(taskId);
      return { outcome: "failed" as const, error: message };
    });

  const yieldTimeMs = params.yieldTimeMs ?? SLACK_ATTACHMENT_DOWNLOAD_YIELD_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const yieldPromise = new Promise<SlackAttachmentDownloadOutcome>(
    (resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ outcome: "backgrounded", taskId }),
        yieldTimeMs,
      );
      timeoutHandle.unref?.();
    },
  );

  try {
    return await Promise.race([downloadPromise, yieldPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}
