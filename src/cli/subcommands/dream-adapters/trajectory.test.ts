import { describe, expect, test } from "bun:test";
import type { NormalizedSession } from "@/agent/trajectories/types";
import { normalizedSessionToExternalEntries } from "./trajectory";

describe("normalizedSessionToExternalEntries", () => {
  test("converts normalized-v1 messages into reflection transcript entries", () => {
    const session: NormalizedSession = {
      session: {
        harness: "claude",
        sessionId: "session-1",
        path: "/tmp/session-1.jsonl",
        startTime: "2026-07-04T09:00:00.000Z",
        endTime: "2026-07-04T09:00:03.000Z",
        estTokens: 10,
        recordCount: 4,
        mtimeMs: 0,
      },
      records: [
        { role: "meta", source: "claude_code" },
        {
          role: "user",
          content: "Fix the test",
          timestamp: "2026-07-04T09:00:00.000Z",
        },
        {
          role: "reasoning",
          content: "Need to inspect failure.",
          timestamp: "2026-07-04T09:00:01.000Z",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "toolu_1", name: "Bash", args: '{"cmd":"bun test"}' },
          ],
          timestamp: "2026-07-04T09:00:02.000Z",
        },
        {
          role: "tool",
          tool_call_id: "toolu_1",
          content: "1 pass",
          timestamp: "2026-07-04T09:00:03.000Z",
        },
        {
          role: "assistant",
          content: "Done.",
          timestamp: "2026-07-04T09:00:04.000Z",
        },
      ],
    };

    expect(normalizedSessionToExternalEntries(session)).toEqual([
      {
        kind: "user",
        text: "Fix the test",
        captured_at: "2026-07-04T09:00:00.000Z",
        source_message_id: "claude:session-1:1",
      },
      {
        kind: "reasoning",
        text: "Need to inspect failure.",
        captured_at: "2026-07-04T09:00:01.000Z",
        source_message_id: "claude:session-1:2",
      },
      {
        kind: "tool_call",
        name: "Bash",
        argsText: '{"cmd":"bun test"}',
        resultText: "1 pass",
        resultOk: true,
        captured_at: "2026-07-04T09:00:02.000Z",
        source_message_id: "claude:session-1:3:tool:0:toolu_1",
      },
      {
        kind: "assistant",
        text: "Done.",
        captured_at: "2026-07-04T09:00:04.000Z",
        source_message_id: "claude:session-1:5",
      },
    ]);
  });
});
