import { describe, expect, test } from "bun:test";
import { allocateImage } from "@/cli/helpers/paste-registry";
import {
  buildQueuedContentParts,
  buildQueuedUserText,
  getQueuedNotificationSummaries,
  toQueuedMsg,
} from "@/cli/helpers/queued-message-parts";
import {
  QueueRuntime,
  type TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";

describe("queuedMessageParts", () => {
  test("buildQueuedUserText only concatenates user messages", () => {
    const queued: QueuedMessage[] = [
      { kind: "user", text: "hello" },
      {
        kind: "task_notification",
        text: "<task-notification><summary>Agent done</summary></task-notification>",
      },
      { kind: "user", text: "world" },
    ];

    expect(buildQueuedUserText(queued)).toBe("hello\nworld");
  });

  test("buildQueuedContentParts preserves boundaries and images", () => {
    const imageId = allocateImage({
      data: "ZmFrZQ==",
      mediaType: "image/png",
    });
    const userText = `before [Image #${imageId}] after`;
    const notificationXml = formatTaskNotification({
      taskId: "task_1",
      status: "completed",
      summary: 'Agent "Test" completed',
      result: "Result line",
      outputFile: "/tmp/task_1.log",
    });

    const queued: QueuedMessage[] = [
      { kind: "user", text: userText },
      { kind: "task_notification", text: notificationXml },
      { kind: "user", text: "second" },
    ];

    const parts = buildQueuedContentParts(queued);

    expect(parts).toHaveLength(7);
    expect(parts[0]).toEqual({ type: "text", text: "before " });
    expect(parts[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "ZmFrZQ==",
      },
    });
    expect(parts[2]).toEqual({ type: "text", text: " after" });
    expect(parts[3]).toEqual({ type: "text", text: "\n" });
    expect(parts[4]).toEqual({ type: "text", text: notificationXml });
    expect(parts[5]).toEqual({ type: "text", text: "\n" });
    expect(parts[6]).toEqual({ type: "text", text: "second" });
  });

  test("TUI display bridge keeps a task notification's image parts", () => {
    const queue = new QueueRuntime();
    const image = {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png",
        data: "ZmFrZQ==",
      },
    };
    const notification: Omit<TaskNotificationQueueItem, "id" | "enqueuedAt"> = {
      kind: "task_notification",
      source: "task_notification",
      text: "<task-notification>ready</task-notification>",
      content: [{ type: "text", text: "caption" }, image],
    };
    const item = queue.enqueue(notification);
    if (!item || item.kind !== "task_notification") {
      throw new Error("Expected a queued task notification");
    }
    expect(buildQueuedContentParts([toQueuedMsg(item)])).toEqual([
      { type: "text", text: item.text },
      { type: "text", text: "\n" },
      { type: "text", text: "caption" },
      image,
    ]);
  });

  test("getQueuedNotificationSummaries extracts summaries", () => {
    const notificationXml = formatTaskNotification({
      taskId: "task_2",
      status: "completed",
      summary: 'Agent "General-purpose" completed',
      result: "Done",
      outputFile: "/tmp/task_2.log",
    });

    const queued: QueuedMessage[] = [
      { kind: "user", text: "hi" },
      { kind: "task_notification", text: notificationXml },
    ];

    expect(getQueuedNotificationSummaries(queued)).toEqual([
      'Agent "General-purpose" completed',
    ]);
  });
});
