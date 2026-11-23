import type { ChannelMessageAttachment } from "@/channels/types";
import {
  appendToOutputFile,
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextDownloadId,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { addToMessageQueue } from "@/utils/message-queue-bridge";
import {
  formatTaskNotification,
  resolveNotificationScope,
} from "@/utils/task-notifications";

export const SLACK_ATTACHMENT_DOWNLOAD_YIELD_MS = 10_000;

export type SlackAttachmentDownloadOutcome =
  | { outcome: "completed"; attachment: ChannelMessageAttachment }
  | { outcome: "failed"; error: string }
  | { outcome: "backgrounded"; taskId: string; outputFile: string };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSlackAttachmentDownloadTask(params: {
  description: string;
  download: (signal: AbortSignal) => Promise<ChannelMessageAttachment>;
  yieldTimeMs?: number;
  runtimeScope: { agentId: string; conversationId: string };
}): Promise<SlackAttachmentDownloadOutcome> {
  assertBackgroundProcessCapacity();

  const taskId = getNextDownloadId();
  const outputFile = createBackgroundOutputFile(taskId);
  const abortController = new AbortController();
  const notificationScope = resolveNotificationScope(params.runtimeScope);
  let backgrounded = false;
  const processState: BackgroundProcess = {
    process: {
      kill: () => {
        abortController.abort();
        return true;
      },
    },
    command: params.description,
    status: "running",
    exitCode: null,
    startTime: new Date(),
    outputFile,
    runtimeScope: params.runtimeScope,
  };
  backgroundProcesses.set(taskId, processState);
  appendToOutputFile(outputFile, `${params.description}\n`);

  const notifyIfBackgrounded = (
    status: "completed" | "failed",
    result: string,
  ) => {
    if (!backgrounded || processState.completionNotificationSuppressed) return;
    addToMessageQueue({
      kind: "task_notification",
      text: formatTaskNotification({
        taskId,
        status,
        summary: `${params.description} ${status}`,
        result,
        outputFile,
      }),
      ...notificationScope,
    });
  };

  const downloadPromise = params
    .download(abortController.signal)
    .then((attachment) => {
      const line = `Slack attachment downloaded (local_path: ${attachment.localPath})`;
      processState.status = "completed";
      processState.exitCode = 0;
      appendToOutputFile(outputFile, `${line}\n`);
      scheduleBackgroundProcessCleanup(taskId);
      notifyIfBackgrounded("completed", line);
      notifyBackgroundProcessStateChanged(processState.runtimeScope);
      return { outcome: "completed" as const, attachment };
    })
    .catch((error: unknown) => {
      const message = toErrorMessage(error);
      const line = `Slack attachment download failed: ${message}`;
      processState.status = "failed";
      processState.exitCode = 1;
      appendToOutputFile(outputFile, `${line}\n`);
      scheduleBackgroundProcessCleanup(taskId);
      notifyIfBackgrounded("failed", line);
      notifyBackgroundProcessStateChanged(processState.runtimeScope);
      return { outcome: "failed" as const, error: message };
    });

  const yieldTimeMs = params.yieldTimeMs ?? SLACK_ATTACHMENT_DOWNLOAD_YIELD_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const yieldPromise = new Promise<SlackAttachmentDownloadOutcome>(
    (resolve) => {
      timeoutHandle = setTimeout(() => {
        backgrounded = true;
        resolve({ outcome: "backgrounded", taskId, outputFile });
      }, yieldTimeMs);
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
