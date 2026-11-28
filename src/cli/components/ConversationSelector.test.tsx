import { expect, test } from "bun:test";
import type {
  LettaUserMessageContentUnion,
  UserMessage,
} from "@letta-ai/letta-client/resources/agents/messages";
import { formatScheduledTaskPrompt } from "@/cron/scheduled-task-prompt";
import { formatMultimodalTaskNotification } from "@/utils/task-notifications";
import { extractUserMessagePreview } from "./ConversationSelector";
import { splitSystemReminderBlocks } from "./UserMessageRich";

test("recognizes a split notification in conversation previews and clipped history", () => {
  const content = formatMultimodalTaskNotification(
    {
      taskId: "task-1",
      status: "completed",
      summary: "Tool capture completed",
    },
    [{ type: "text", text: "Long tool result ".repeat(100) }],
  ).filter(
    (part): part is LettaUserMessageContentUnion =>
      part.type === "text" || part.type === "image",
  );
  const message: UserMessage = {
    id: "message-1",
    date: "2026-01-01T00:00:00Z",
    message_type: "user_message",
    content,
  };

  expect(extractUserMessagePreview(message)).toBeNull();
  const withQuestion: UserMessage = {
    ...message,
    content: [...content, { type: "text", text: "What did you find?" }],
  };
  expect(extractUserMessagePreview(withQuestion)).toBe("What did you find?");
});

test("hides the payload of a legacy notification in conversation previews", () => {
  const message: UserMessage = {
    id: "message-2",
    date: "2026-01-01T00:00:00Z",
    message_type: "user_message",
    content: [
      { type: "text", text: "Check the screenshot" },
      {
        type: "text",
        text: "<task-notification><summary>Done</summary></task-notification>",
      },
      { type: "text", text: "<external-tool-result>" },
      { type: "text", text: "<text>Tool output</text>" },
      { type: "text", text: "</external-tool-result>" },
    ],
  };
  expect(extractUserMessagePreview(message)).toBe("Check the screenshot");
});

test("shows a scheduled fire in previews and history with ordinary reminders hidden", () => {
  const time = new Date("2026-01-01T00:00:00Z");
  const scheduled = formatScheduledTaskPrompt({
    name: "Daily status",
    timezone: "UTC",
    scheduledFor: time,
    currentTime: time,
    recurrence: { type: "one-off" },
    prompt: "Summarize open items.",
  });
  const message: UserMessage = {
    id: "schedule-1",
    date: time.toISOString(),
    message_type: "user_message",
    content: [
      {
        type: "text",
        text: "<system-reminder>Private context</system-reminder>",
      },
      { type: "text", text: scheduled },
    ],
  };

  expect(extractUserMessagePreview(message)).toStartWith(
    'Scheduled task "Daily status" is firing.',
  );
  const live = splitSystemReminderBlocks(
    `<system-reminder>Private context</system-reminder>\n${scheduled}`,
  );
  expect(live[0]?.isSystemReminder).toBe(true);
  expect(live[1]?.isSystemReminder).toBe(false);
  expect(live[1]?.text).toContain("Summarize open items.");
});
