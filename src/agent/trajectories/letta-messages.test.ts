import { describe, expect, test } from "bun:test";
import { normalizeLettaMessages } from "./letta-messages";

describe("normalizeLettaMessages", () => {
  test("converts listed conversation messages into normalized-v1 records", () => {
    const records = normalizeLettaMessages([
      {
        message_type: "user_message",
        content: "Process reflection batch 0",
        date: "2026-07-01T10:00:00Z",
      },
      {
        message_type: "reasoning_message",
        reasoning: "I should read the payload first.",
        date: "2026-07-01T10:00:05Z",
      },
      {
        message_type: "tool_call_message",
        date: "2026-07-01T10:00:06Z",
        tool_call: {
          name: "Bash",
          tool_call_id: "call_1",
          arguments: '{"command":"cat payload.json"}',
        },
      },
      {
        message_type: "tool_return_message",
        date: "2026-07-01T10:00:07Z",
        status: "success",
        tool_call_id: "call_1",
        tool_return: '{"sessions":[]}',
      },
      {
        message_type: "assistant_message",
        content: "Done. No durable learnings.",
        date: "2026-07-01T10:00:20Z",
      },
      { message_type: "usage_statistics" },
      "not an object",
    ]);

    expect(records).not.toBeNull();
    const body = (records ?? []).filter((r) => r.role !== "meta");
    expect(body.map((r) => r.role)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "tool",
      "assistant",
    ]);
    const meta = (records ?? [])[0];
    expect(meta?.role).toBe("meta");
    expect(meta?.source).toBe("letta-code");
    const toolCall = body.find((r) => r.tool_calls);
    expect(toolCall?.tool_calls?.[0]?.name).toBe("Bash");
    const toolResult = body.find((r) => r.role === "tool");
    expect(toolResult?.tool_call_id).toBe(toolCall?.tool_calls?.[0]?.id);
  });

  test("marks error tool returns and handles Date objects", () => {
    const records = normalizeLettaMessages([
      {
        message_type: "user_message",
        content: "go",
        date: new Date("2026-07-01T10:00:00Z"),
      },
      {
        message_type: "tool_call_message",
        date: "2026-07-01T10:00:01Z",
        tool_call: { name: "Bash", tool_call_id: "c1", arguments: "{}" },
      },
      {
        message_type: "tool_return_message",
        date: "2026-07-01T10:00:02Z",
        status: "error",
        tool_call_id: "c1",
        tool_return: "command not found",
      },
    ]);
    const toolResult = (records ?? []).find((r) => r.role === "tool");
    expect(toolResult?.content).toMatch(/^Error: command not found/);
  });

  test("treats approval_request_message as a tool call (listed conversations)", () => {
    const records = normalizeLettaMessages([
      {
        message_type: "user_message",
        content: "go",
        date: "2026-07-01T10:00:00Z",
      },
      {
        message_type: "approval_request_message",
        date: "2026-07-01T10:00:01Z",
        tool_calls: [
          { name: "Bash", tool_call_id: "c9", arguments: '{"command":"ls"}' },
        ],
      },
      { message_type: "approval_response_message" },
      {
        message_type: "tool_return_message",
        date: "2026-07-01T10:00:02Z",
        status: "success",
        tool_call_id: "c9",
        tool_return: "output",
      },
    ]);
    const body = (records ?? []).filter((r) => r.role !== "meta");
    expect(body.map((r) => r.role)).toEqual(["user", "assistant", "tool"]);
    const call = body.find((r) => r.tool_calls);
    expect(call?.tool_calls?.[0]?.name).toBe("Bash");
  });

  test("returns null when nothing conversational is present", () => {
    expect(
      normalizeLettaMessages([
        { message_type: "usage_statistics" },
        { message_type: "stop_reason" },
      ]),
    ).toBeNull();
  });
});
