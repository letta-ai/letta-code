import { describe, expect, test } from "bun:test";
import { buildConversationMessagesCreateRequestBody } from "../../agent/message";

describe("buildConversationMessagesCreateRequestBody client_skills", () => {
  test("includes client_skills alongside client_tools", () => {
    const body = buildConversationMessagesCreateRequestBody(
      "default",
      [{ type: "message", role: "user", content: "hello" }],
      { agentId: "agent-1", streamTokens: true, background: true },
      [
        {
          name: "ShellCommand",
          description: "Run shell command",
          parameters: { type: "object", properties: {} },
        },
      ],
      [
        {
          name: "debugging",
          description: "Debugging checklist",
          location: "/tmp/.skills/debugging/SKILL.md",
        },
      ],
    );

    expect(body.client_tools).toHaveLength(1);
    expect(body.client_skills).toEqual([
      {
        name: "debugging",
        description: "Debugging checklist",
        location: "/tmp/.skills/debugging/SKILL.md",
      },
    ]);
  });
});
