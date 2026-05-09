import { describe, expect, test } from "bun:test";
import {
  buildAgentReference,
  buildAgentTerminalLink,
  buildChatUrl,
  isLocalAgentId,
} from "../../cli/helpers/appUrls";

describe("app URL helpers", () => {
  test("buildChatUrl links API-backed agents to the web app", () => {
    expect(buildChatUrl("agent-123")).toBe(
      "https://app.letta.com/chat/agent-123",
    );
  });

  test("buildAgentReference links API-backed agents to the web app", () => {
    expect(
      buildAgentReference("agent-123", { conversationId: "conv-123" }),
    ).toBe("https://app.letta.com/chat/agent-123?conversation=conv-123");
  });

  test("buildAgentReference displays local-backend agents by ID", () => {
    expect(
      buildAgentReference("agent-local-abc", { conversationId: "default" }),
    ).toBe("agent-local-abc");
  });

  test("isLocalAgentId detects local-backend agents", () => {
    expect(isLocalAgentId("agent-local-abc")).toBe(true);
    expect(isLocalAgentId("agent-abc")).toBe(false);
  });

  test("buildAgentTerminalLink only hyperlinks API-backed agents", () => {
    expect(buildAgentTerminalLink("agent-local-abc")).toBe("agent-local-abc");
    expect(buildAgentTerminalLink("agent-abc")).toBe(
      "\x1b]8;;https://app.letta.com/chat/agent-abc\x1b\\agent-abc\x1b]8;;\x1b\\",
    );
  });
});
