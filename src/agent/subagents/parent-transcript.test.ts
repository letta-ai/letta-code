import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import {
  fetchParentConversationMessages,
  renderParentTranscript,
  selectRecentMessages,
} from "./parent-transcript";

const date = "2026-01-01T00:00:00Z";
function msg(fields: Record<string, unknown>): Message {
  return { id: `m-${Math.random()}`, date, ...fields } as unknown as Message;
}
const user = (content: unknown) =>
  msg({ message_type: "user_message", content });
const assistant = (content: string) =>
  msg({ message_type: "assistant_message", content });
const toolCall = (name: string, args: string) =>
  msg({
    message_type: "tool_call_message",
    tool_call: { name, arguments: args, tool_call_id: "call-1" },
  });
const toolReturn = (tool_return: string, status = "success") =>
  msg({
    message_type: "tool_return_message",
    tool_call_id: "call-1",
    status,
    tool_return,
  });

describe("renderParentTranscript", () => {
  test("renders turns with tool calls and results, omitting reasoning and system", () => {
    const { messages, markdown } = renderParentTranscript([
      msg({ message_type: "system_message", content: "SYSTEM PROMPT" }),
      user("Fix the flaky test in src/a.test.ts"),
      msg({ message_type: "reasoning_message", reasoning: "SECRET THOUGHTS" }),
      toolCall("Bash", '{"command":"bun test src/a.test.ts"}'),
      toolReturn("1 fail", "error"),
      assistant("The timeout is too short."),
      user("Go ahead and raise it"),
      assistant("Done."),
    ]);

    expect(messages).toHaveLength(6);
    expect(messages[0]).toContain(
      "### User\n\nFix the flaky test in src/a.test.ts",
    );
    expect(messages[1]).toContain("**Tool call: Bash**");
    expect(messages[1]).toContain('{"command":"bun test src/a.test.ts"}');
    expect(messages[2]).toContain("**Tool result (error)**");
    expect(messages[3]).toContain("### Assistant\n\nThe timeout is too short.");
    expect(messages[4]).toStartWith("### User\n\nGo ahead and raise it");
    expect(markdown).not.toContain("SECRET THOUGHTS");
    expect(markdown).not.toContain("SYSTEM PROMPT");
  });

  test("strips system reminders and drops reminder-only user messages", () => {
    const { messages } = renderParentTranscript([
      user([
        {
          type: "text",
          text: "<system-reminder>skills list</system-reminder>",
        },
      ]),
      user([
        {
          type: "text",
          text: "<system-reminder>cwd: /x</system-reminder>\nReal question",
        },
      ]),
    ]);

    expect(messages).toEqual(["### User\n\nReal question"]);
  });

  test("preserves long tool results and arguments", () => {
    const args = `{"content":"${"a".repeat(8_000)}"}`;
    const result = "r".repeat(60_000);
    const { markdown } = renderParentTranscript([
      user("go"),
      toolCall("Write", args),
      toolReturn(result),
    ]);

    expect(markdown).toContain(args);
    expect(markdown).toContain(result);
    expect(markdown).not.toContain("truncated:");
  });

  test("renders client-side tool results from approval responses", () => {
    const { markdown } = renderParentTranscript([
      user("go"),
      msg({
        message_type: "approval_request_message",
        tool_call: { name: "Read", arguments: '{"file_path":"/a"}' },
      }),
      msg({
        message_type: "approval_response_message",
        approvals: [
          {
            type: "tool",
            tool_call_id: "c",
            status: "success",
            tool_return: "file body",
          },
          {
            type: "approval",
            tool_call_id: "d",
            approve: false,
            reason: "not that one",
          },
        ],
      }),
    ]);

    expect(markdown).toContain("**Tool call: Read**");
    expect(markdown).toContain("file body");
    expect(markdown).toContain("**Tool call denied**: not that one");
  });

  test("keeps fenced results intact when they contain fences", () => {
    const { markdown } = renderParentTranscript([
      user("go"),
      toolReturn("```ts\nconst x = 1;\n```"),
    ]);

    expect(markdown).toContain("````\n```ts\nconst x = 1;\n```\n````");
  });

  test("starts a turn at a compaction summary", () => {
    const { messages } = renderParentTranscript([
      msg({ message_type: "summary_message", summary: "Earlier: set up repo" }),
      user("next"),
    ]);

    expect(messages[0]).toBe(
      "### Summary of earlier conversation\n\nEarlier: set up repo",
    );
    expect(messages).toHaveLength(2);
  });
});

describe("selectRecentMessages", () => {
  test("keeps the newest complete messages that fit, oldest first", () => {
    const messages = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
    const { text, messageCount, earlier } = selectRecentMessages(messages, 110);

    expect(messageCount).toBe(2);
    expect(earlier).toBe("a".repeat(50));
    expect(text).toBe(`${"b".repeat(50)}\n\n---\n\n${"c".repeat(50)}`);
  });

  test("has no message-count cap and includes separators in the budget", () => {
    const messages = Array.from({ length: 20 }, (_, i) => `${i}`);
    const full = messages.join("\n\n---\n\n");
    expect(selectRecentMessages(messages, full.length)).toEqual({
      text: full,
      messageCount: 20,
      earlier: "",
    });
    expect(selectRecentMessages(messages, full.length - 1).messageCount).toBe(
      19,
    );
  });

  test("preserves an oversized latest message entirely in the file portion", () => {
    const last = `${"x".repeat(500)}LATEST REQUEST`;
    const { text, messageCount, earlier } = selectRecentMessages(
      ["old", last],
      100,
    );

    expect(messageCount).toBe(0);
    expect(text).toBe("");
    expect(earlier).toBe(`old\n\n---\n\n${last}`);
  });
});

describe("fetchParentConversationMessages", () => {
  test("pages oldest-first with an after cursor until a short page", async () => {
    const all = Array.from({ length: 250 }, (_, i) =>
      msg({ id: `m${i}`, message_type: "user_message", content: `${i}` }),
    );
    const calls: Array<Record<string, unknown>> = [];
    const backend = {
      listConversationMessages: async (
        _conversationId: string,
        body: Record<string, unknown>,
      ) => {
        calls.push(body);
        const start = body.after
          ? all.findIndex((m) => m.id === body.after) + 1
          : 0;
        const items = all.slice(start, start + (body.limit as number));
        return { getPaginatedItems: () => items };
      },
    } as unknown as Pick<Backend, "listConversationMessages">;

    const messages = await fetchParentConversationMessages({
      backend,
      agentId: "agent-parent",
      conversationId: "default",
    });

    expect(messages.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(calls.map((c) => c.after)).toEqual([undefined, "m99", "m199"]);
    expect(calls.every((c) => c.order === "asc")).toBe(true);
    expect(calls.every((c) => c.agent_id === "agent-parent")).toBe(true);
  });
});
