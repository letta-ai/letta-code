import { expect, test } from "bun:test";
import type {
  LettaUserMessageContentUnion,
  UserMessage,
} from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import { formatMultimodalTaskNotification } from "@/utils/task-notifications";
import { extractUserMessagePreview } from "./ConversationSelector";

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

  const buffers = createBuffers();
  backfillBuffers(buffers, [withQuestion]);
  expect(buffers.byId.get("message-1-task-0")).toMatchObject({
    eventType: "task_notification",
    summary: "Tool capture completed",
  });
  expect(buffers.byId.get("message-1")).toMatchObject({
    kind: "user",
    text: "What did you find?",
  });
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
