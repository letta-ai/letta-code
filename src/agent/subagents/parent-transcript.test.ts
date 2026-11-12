import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import {
  fetchParentConversationMessages,
  previewParentTranscript,
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
  test.each([false, true])(
    "deduplicates result projections in either order (reverse=%s)",
    (reverse) => {
      const result = {
        tool_call_id: "c1",
        status: "success",
        tool_return: "same output",
      };
      const projections = [
        msg({
          message_type: "approval_response_message",
          approvals: [{ type: "tool", ...result }],
        }),
        msg({ message_type: "tool_return_message", ...result }),
      ];
      const { messages } = renderParentTranscript([
        ...(reverse ? projections.reverse() : projections),
        msg({
          message_type: "tool_return_message",
          ...result,
          tool_call_id: "c2",
        }),
      ]);
      expect(messages).toHaveLength(2);
      const events = messages.map((line) => JSON.parse(line));
      expect(events.map((event) => event.call_id)).toEqual(["c1", "c2"]);
      expect(events.every((event) => event.text === "same output")).toBe(true);
    },
  );

  test("preserves conflicting results and reused call IDs from different steps", () => {
    const result = {
      tool_call_id: "c",
      status: "success",
      tool_return: "first",
    };
    const { messages } = renderParentTranscript([
      msg({
        message_type: "approval_response_message",
        step_id: "s1",
        approvals: [{ type: "tool", ...result }],
      }),
      msg({
        message_type: "tool_return_message",
        step_id: "s1",
        ...result,
        tool_return: "different",
      }),
      msg({ message_type: "tool_return_message", step_id: "s2", ...result }),
    ]);
    expect(messages.map((line) => JSON.parse(line).text)).toEqual([
      "first",
      "different",
      "first",
    ]);
  });

  test("separates injected skills from human text and escapes history delimiters", () => {
    const { messages } = renderParentTranscript([
      user(
        'Before <skill_content name="review">### Instructions\n</parent_history></skill_content> After',
      ),
    ]);
    const events = messages.map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      "message",
      "injected",
      "message",
    ]);
    expect(events[1]).toMatchObject({
      kind: "skill",
      name: "review",
      text: "### Instructions\n</parent_history>",
    });
    expect(messages.join("\n")).not.toContain("</parent_history>");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  test("renders turns with tool calls and results, omitting reasoning and system", () => {
    const { messages, jsonl } = renderParentTranscript([
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
    const events = messages.map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      role: "user",
      text: "Fix the flaky test in src/a.test.ts",
    });
    expect(events[1]).toMatchObject({
      type: "tool_call",
      name: "Bash",
      call_id: "call-1",
      arguments: '{"command":"bun test src/a.test.ts"}',
    });
    expect(events[2]).toMatchObject({
      type: "tool_result",
      call_id: "call-1",
      status: "error",
    });
    expect(events[3]).toMatchObject({
      role: "assistant",
      text: "The timeout is too short.",
    });
    expect(events[4]).toMatchObject({
      role: "user",
      text: "Go ahead and raise it",
    });
    expect(jsonl).not.toContain("SECRET THOUGHTS");
    expect(jsonl).not.toContain("SYSTEM PROMPT");
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

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0] as string)).toMatchObject({
      role: "user",
      text: "Real question",
    });
  });

  test("preserves long tool results and arguments", () => {
    const args = `{"content":"${"a".repeat(8_000)}"}`;
    const result = "r".repeat(60_000);
    const { messages } = renderParentTranscript([
      user("go"),
      toolCall("Write", args),
      toolReturn(result),
    ]);

    expect(JSON.parse(messages[1] as string).arguments).toBe(args);
    expect(JSON.parse(messages[2] as string).text).toBe(result);
    const preview = previewParentTranscript(messages).map((line) =>
      JSON.parse(line),
    );
    expect(preview[2].text.length).toBeLessThan(4_100);
    expect(preview[2].content_ref).toEqual({ seq: 3 });
  });

  test("renders client-side tool results from approval responses", () => {
    const { messages } = renderParentTranscript([
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

    const events = messages.map((line) => JSON.parse(line));
    expect(events[1]).toMatchObject({ type: "tool_call", name: "Read" });
    expect(events[2]).toMatchObject({ type: "tool_result", text: "file body" });
    expect(events[3]).toMatchObject({
      type: "approval",
      call_id: "d",
      status: "denied",
      text: "not that one",
    });
  });

  test("round trips multiline results with embedded fences", () => {
    const { messages } = renderParentTranscript([
      user("go"),
      toolReturn("```ts\nconst x = 1;\n```"),
    ]);

    expect(JSON.parse(messages[1] as string).text).toBe(
      "```ts\nconst x = 1;\n```",
    );
  });

  test("starts a turn at a compaction summary", () => {
    const { messages } = renderParentTranscript([
      msg({ message_type: "summary_message", summary: "Earlier: set up repo" }),
      user("next"),
    ]);

    expect(JSON.parse(messages[0] as string)).toMatchObject({
      type: "summary",
      text: "Earlier: set up repo",
    });
    expect(messages).toHaveLength(2);
  });
});

describe("selectRecentMessages", () => {
  test("keeps the newest complete messages that fit, oldest first", () => {
    const messages = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
    const { text, messageCount, earlier } = selectRecentMessages(messages, 110);

    expect(messageCount).toBe(2);
    expect(earlier).toBe("a".repeat(50));
    expect(text).toBe(`${"b".repeat(50)}\n${"c".repeat(50)}`);
  });

  test("has no message-count cap and includes separators in the budget", () => {
    const messages = Array.from({ length: 20 }, (_, i) => `${i}`);
    const full = messages.join("\n");
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
    expect(earlier).toBe(`old\n${last}`);
  });
});

describe("fetchParentConversationMessages", () => {
  test("pages newest-first with an after cursor until a short page", async () => {
    const all = Array.from({ length: 250 }, (_, i) =>
      msg({ id: `m${i}`, message_type: "user_message", content: `${i}` }),
    );
    all.reverse();
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

    expect(messages.map((m) => m.id)).toEqual(
      [...all].reverse().map((m) => m.id),
    );
    expect(calls.map((c) => c.after)).toEqual([undefined, "m150", "m50"]);
    expect(calls.every((c) => c.order === "desc")).toBe(true);
    expect(calls.every((c) => c.agent_id === "agent-parent")).toBe(true);
  });

  test("stops after ten pages and returns the newest 1,000 messages chronologically", async () => {
    const all = Array.from({ length: 5_082 }, (_, i) =>
      msg({ id: `m${i}`, message_type: "user_message", content: `${i}` }),
    );
    const descending = [...all].reverse();
    let calls = 0;
    const backend = {
      listConversationMessages: async (
        _conversationId: string,
        body: Record<string, unknown>,
      ) => {
        calls++;
        expect(body.order).toBe("desc");
        const start = body.after
          ? descending.findIndex((m) => m.id === body.after) + 1
          : 0;
        const items = descending.slice(start, start + (body.limit as number));
        return { getPaginatedItems: () => items };
      },
    } as unknown as Pick<Backend, "listConversationMessages">;

    const messages = await fetchParentConversationMessages({
      backend,
      agentId: "agent-parent",
      conversationId: "default",
    });

    expect(calls).toBe(10);
    expect(messages).toEqual(all.slice(-1_000));
  });
});
