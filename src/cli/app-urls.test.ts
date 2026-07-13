import { describe, expect, test } from "bun:test";
import {
  isAgentIdCompatibleWithBackend,
  isCloudAgentId,
} from "@/agent/agent-id";
import {
  buildAgentReference,
  buildAgentTerminalLink,
  buildChatUrl,
  isLocalAgentId,
  LETTA_API_KEYS_URL,
} from "@/cli/helpers/app-urls";

describe("app URL helpers", () => {
  test("LETTA_API_KEYS_URL uses the project-scoped API keys page", () => {
    expect(LETTA_API_KEYS_URL).toBe(
      "https://app.letta.com/projects/default-project/api-keys",
    );
    expect(LETTA_API_KEYS_URL).not.toBe("https://app.letta.com/api-keys");
  });

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

  test("cloud/local agent ID helpers are backend-aware", () => {
    expect(isCloudAgentId("agent-abc")).toBe(true);
    expect(isCloudAgentId("agent-local-abc")).toBe(false);
    expect(isAgentIdCompatibleWithBackend("agent-local-abc", "local")).toBe(
      true,
    );
    expect(isAgentIdCompatibleWithBackend("agent-local-abc", "api")).toBe(
      false,
    );
    expect(isAgentIdCompatibleWithBackend("agent-abc", "api")).toBe(true);
    expect(isAgentIdCompatibleWithBackend("agent-abc", "local")).toBe(false);
  });

  test("buildAgentTerminalLink only hyperlinks API-backed agents", () => {
    expect(buildAgentTerminalLink("agent-local-abc")).toBe("agent-local-abc");
    expect(buildAgentTerminalLink("agent-abc")).toBe(
      "\x1b]8;;https://app.letta.com/chat/agent-abc\x1b\\agent-abc\x1b]8;;\x1b\\",
    );
  });

  test("buildAgentTerminalLink supports a custom label with the same chat URL target", () => {
    const targetUrl = buildChatUrl("agent-abc");
    expect(buildAgentTerminalLink("agent-abc", undefined, "memories")).toBe(
      `\x1b]8;;${targetUrl}\x1b\\memories\x1b]8;;\x1b\\`,
    );
  });
});
