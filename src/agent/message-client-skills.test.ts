import { describe, expect, test } from "bun:test";
import {
  buildConversationMessagesCreateRequestBody,
  sendMessageStreamWithBackend,
} from "@/agent/message";
import type { Backend } from "@/backend";

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

  test("an explicit empty runtime skill scope sends no client skills on every turn", async () => {
    const requestBodies: Array<{ client_skills?: unknown[] }> = [];
    const emptyStream = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    const backend = {
      createConversationMessageStream: async (
        _conversationId: string,
        body: { client_skills?: unknown[] },
      ) => {
        requestBodies.push(body);
        return emptyStream;
      },
    } as unknown as Backend;
    const preparedToolContext = {
      contextId: "no-skills-context",
      clientTools: [],
      loadedToolNames: [],
    };

    for (const content of ["initial reflection", "continued reflection"]) {
      await sendMessageStreamWithBackend(
        backend,
        "conv-reflector",
        [{ type: "message", role: "user", content }],
        {
          agentId: "agent-reflector",
          preparedToolContext,
          skillSources: [],
          skipImageNormalization: true,
        },
      );
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.map((body) => body.client_skills)).toEqual([[], []]);
  });
});
