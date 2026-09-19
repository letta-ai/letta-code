import { describe, expect, test } from "bun:test";
import { insertMidConversationSystemMessage } from "@/backend/dev/pi-stream-mid-conversation";

// The backend decides WHETHER a memory update goes out mid-conversation
// (supportsMidConversationSystemMessages); this decides WHERE it lands in the
// provider payload. Anthropic rejects a mid-conversation `system` message that
// is first in the array or does not follow a user turn, and pi-ai may already
// have appended a trailing `system` message carrying output_config.effort for
// models with supportsMidConvoEffort (e.g. Opus 5, Fable 5.1).
describe("insertMidConversationSystemMessage", () => {
  const update = "<memory_update>fresh</memory_update>";

  test("appends after the last conversation message", () => {
    const out = insertMidConversationSystemMessage(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      update,
    );
    expect(out.map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
      "system",
    ]);
    expect((out[3] as { content: string }).content).toBe(update);
  });

  test("lands before a trailing effort system message, right after the user turn", () => {
    const effort = {
      role: "system",
      content: [],
      output_config: { effort: "max" },
    };
    const out = insertMidConversationSystemMessage(
      [{ role: "user", content: "first" }, effort],
      update,
    );
    expect(out.map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "system",
      "system",
    ]);
    expect((out[1] as { content: string }).content).toBe(update);
    expect(out[2]).toBe(effort);
  });

  test("keeps historical effort markers where they were", () => {
    const e1 = {
      role: "system",
      content: [],
      output_config: { effort: "low" },
    };
    const e2 = {
      role: "system",
      content: [],
      output_config: { effort: "high" },
    };
    const out = insertMidConversationSystemMessage(
      [
        { role: "user", content: "a" },
        e1,
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        e2,
      ],
      update,
    );
    expect(out.map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "system",
      "assistant",
      "user",
      "system",
      "system",
    ]);
    expect((out[4] as { content: string }).content).toBe(update);
    expect(out[5]).toBe(e2);
  });

  test("does not inject when there is no conversation message yet", () => {
    const only = [{ role: "system", content: "top-level instructions" }];
    expect(insertMidConversationSystemMessage(only, update)).toBe(only);
    expect(insertMidConversationSystemMessage([], update)).toEqual([]);
  });

  test("treats developer like system for placement (openai-completions)", () => {
    const out = insertMidConversationSystemMessage(
      [
        { role: "developer", content: "instructions" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      update,
    );
    expect(out.map((m) => (m as { role: string }).role)).toEqual([
      "developer",
      "user",
      "assistant",
      "system",
    ]);
  });
});
