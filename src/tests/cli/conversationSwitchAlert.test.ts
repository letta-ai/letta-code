import { describe, expect, test } from "bun:test";
import { buildConversationSwitchAlert } from "../../cli/helpers/conversationSwitchAlert";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";

describe("conversationSwitchAlert", () => {
  test("wraps conversation switch context in system-reminder tags", () => {
    const alert = buildConversationSwitchAlert({
      origin: "resume-selector",
      conversationId: "conv-123",
      isDefault: false,
      messageCount: 14,
      summary: "Bugfix thread",
    });

    expect(alert).toContain(SYSTEM_REMINDER_OPEN);
    expect(alert).toContain(SYSTEM_REMINDER_CLOSE);
    expect(alert).not.toContain("<system-alert>");
    expect(alert).not.toContain("</system-alert>");
    expect(alert).toContain("Conversation resumed via /resume selector.");
    expect(alert).toContain("Conversation: conv-123 (14 messages)");
  });
});
