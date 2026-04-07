import { describe, expect, test } from "bun:test";
import { buildAdeUrl, buildChatUrl } from "../../cli/helpers/appUrls";

describe("appUrls", () => {
  test("buildAdeUrl points to the ADE agent route", () => {
    expect(buildAdeUrl("agent-123")).toBe(
      "https://app.letta.com/agents/agent-123",
    );
  });

  test("buildAdeUrl includes a non-default conversation", () => {
    expect(
      buildAdeUrl("agent-123", {
        conversationId: "conv-456",
      }),
    ).toBe("https://app.letta.com/agents/agent-123?conversation=conv-456");
  });

  test("buildChatUrl keeps the chat route and omits default conversation", () => {
    expect(
      buildChatUrl("agent-123", {
        conversationId: "default",
      }),
    ).toBe("https://app.letta.com/chat/agent-123");
  });

  test("buildChatUrl preserves extra chat query params", () => {
    expect(
      buildChatUrl("agent-123", {
        conversationId: "conv-456",
        view: "tools",
        deviceId: "device-789",
      }),
    ).toBe(
      "https://app.letta.com/chat/agent-123?view=tools&deviceId=device-789&conversation=conv-456",
    );
  });
});
