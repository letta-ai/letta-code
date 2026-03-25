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

  test("fork origin produces forked conversation message", () => {
    const alert = buildConversationSwitchAlert({
      origin: "fork",
      conversationId: "conv-456",
      isDefault: false,
    });

    expect(alert).toContain(SYSTEM_REMINDER_OPEN);
    expect(alert).toContain(SYSTEM_REMINDER_CLOSE);
    expect(alert).toContain("Forked conversation.");
    expect(alert).toContain(
      "This is a copy of the previous conversation with a freshly compiled system message.",
    );
    expect(alert).toContain("Conversation: conv-456");
  });
});
