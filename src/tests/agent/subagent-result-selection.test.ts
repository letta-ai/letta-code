import { describe, expect, test } from "bun:test";
import { pickPreferredSubagentResult } from "../../agent/subagents/manager";

describe("pickPreferredSubagentResult", () => {
  test("prefers streamed assistant output when terminal result is phase header", () => {
    const terminal = "Phase 2: Review Recent Conversation History";
    const streamed =
      "## Reflection Report\n\nLong-form reflection output with memory updates.";

    const selected = pickPreferredSubagentResult(terminal, streamed);
    expect(selected).toBe(streamed);
  });

  test("prefers streamed assistant output when terminal result is very short relative to stream", () => {
    const terminal = "Done.";
    const streamed = "A".repeat(700);

    const selected = pickPreferredSubagentResult(terminal, streamed);
    expect(selected).toBe(streamed);
  });

  test("keeps terminal result when it is substantive", () => {
    const terminal =
      "Final report: completed memory updates with references and summary.";
    const streamed = "A shorter streamed variant.";

    const selected = pickPreferredSubagentResult(terminal, streamed);
    expect(selected).toBe(terminal);
  });

  test("falls back to streamed output when terminal result is empty", () => {
    const selected = pickPreferredSubagentResult("", "Streamed final text");
    expect(selected).toBe("Streamed final text");
  });
});
