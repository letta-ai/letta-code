import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import {
  fetchParentConversationMessages,
  PARENT_TRANSCRIPT_TOOL_ARGS_CHARS,
  PARENT_TRANSCRIPT_TOOL_RESULT_CHARS,
  renderParentTranscript,
  selectRecentTurns,
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
    const { turns, markdown } = renderParentTranscript([
      msg({ message_type: "system_message", content: "SYSTEM PROMPT" }),
      user("Fix the flaky test in src/a.test.ts"),
      msg({ message_type: "reasoning_message", reasoning: "SECRET THOUGHTS" }),
      toolCall("Bash", '{"command":"bun test src/a.test.ts"}'),
      toolReturn("1 fail", "error"),
      assistant("The timeout is too short."),
      user("Go ahead and raise it"),
      assistant("Done."),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toContain(
      "### User\n\nFix the flaky test in src/a.test.ts",
    );
    expect(turns[0]).toContain("**Tool call: Bash**");
    expect(turns[0]).toContain('{"command":"bun test src/a.test.ts"}');
    expect(turns[0]).toContain("**Tool result (error)**");
    expect(turns[0]).toContain("### Assistant\n\nThe timeout is too short.");
    expect(turns[1]).toStartWith("### User\n\nGo ahead and raise it");
    expect(markdown).not.toContain("SECRET THOUGHTS");
    expect(markdown).not.toContain("SYSTEM PROMPT");
  });

  test("strips system reminders and drops reminder-only user messages", () => {
    const { turns } = renderParentTranscript([
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

    expect(turns).toEqual(["### User\n\nReal question"]);
  });

  test("clips long tool results and arguments", () => {
    const { markdown } = renderParentTranscript([
      user("go"),
      toolCall(
        "Write",
        `{"content":"${"a".repeat(PARENT_TRANSCRIPT_TOOL_ARGS_CHARS * 2)}"}`,
      ),
      toolReturn("r".repeat(PARENT_TRANSCRIPT_TOOL_RESULT_CHARS * 10)),
    ]);

    expect(markdown).toContain("[arguments truncated:");
    expect(markdown).toContain("[result truncated: 18,000 more characters]");
    expect(markdown.length).toBeLessThan(
      PARENT_TRANSCRIPT_TOOL_ARGS_CHARS +
        PARENT_TRANSCRIPT_TOOL_RESULT_CHARS +
        1_000,
    );
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
    const { turns } = renderParentTranscript([
      msg({ message_type: "summary_message", summary: "Earlier: set up repo" }),
      user("next"),
    ]);

    expect(turns[0]).toBe(
      "### Summary of earlier conversation\n\nEarlier: set up repo",
    );
    expect(turns).toHaveLength(2);
  });
});

describe("selectRecentTurns", () => {
  test("keeps the newest turns that fit, oldest first", () => {
    const turns = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
    const { text, turnCount } = selectRecentTurns(turns, 110);

    expect(turnCount).toBe(2);
    expect(text).toBe(`${"b".repeat(50)}\n\n---\n\n${"c".repeat(50)}`);
  });

  test("respects the turn cap even when more would fit", () => {
    expect(selectRecentTurns(["a", "b", "c"], 1_000, 2).turnCount).toBe(2);
  });

  test("keeps the end of an oversized last turn within the budget", () => {
    const last = `${"x".repeat(500)}LATEST REQUEST`;
    const { text, turnCount } = selectRecentTurns(["old", last], 100);

    expect(turnCount).toBe(1);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).toStartWith("… [start of this turn omitted]");
    expect(text).toEndWith("LATEST REQUEST");
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
