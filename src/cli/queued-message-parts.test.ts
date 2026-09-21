import { describe, expect, test } from "bun:test";
import { allocateImage } from "@/cli/helpers/paste-registry";
import {
  buildQueuedContentParts,
  buildQueuedUserText,
  consumeQueuedMessagesForContinuation,
  getQueuedNotificationSummaries,
} from "@/cli/helpers/queued-message-parts";
import { QueueRuntime } from "@/queue/queue-runtime";
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

  test("continuation consumption leaves an owner turn intact", () => {
    const queue = new QueueRuntime();
    queue.enqueue({
      kind: "message",
      source: "user",
      content: "append first",
    } as Parameters<typeof queue.enqueue>[0]);
    queue.enqueue({
      kind: "message",
      source: "user",
      content: "owner turn",
      noCoalesce: true,
      ownerRequest: {
        messages: [{ role: "user", content: "owner turn" }],
        clientToolAllowlist: ["Read"],
      },
    } as Parameters<typeof queue.enqueue>[0]);
    queue.enqueue({
      kind: "message",
      source: "user",
      content: "after owner",
    } as Parameters<typeof queue.enqueue>[0]);

    expect(consumeQueuedMessagesForContinuation(queue)).toMatchObject([
      { kind: "user", text: "append first" },
    ]);
    expect(queue.peek()).toMatchObject([
      {
        content: "owner turn",
        noCoalesce: true,
        ownerRequest: { clientToolAllowlist: ["Read"] },
      },
      { content: "after owner" },
    ]);
  });
});
