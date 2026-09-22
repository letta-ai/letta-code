import { describe, expect, test } from "bun:test";
import { parseReasoningEffort, REASONING_EFFORT_ORDER } from "./model";

describe("parseReasoningEffort", () => {
  test("narrows a listed level", () => {
    for (const effort of REASONING_EFFORT_ORDER) {
      expect(parseReasoningEffort(effort)).toEqual({ ok: true, effort });
    }
  });

  test("treats an absent value as no override", () => {
    expect(parseReasoningEffort(undefined)).toEqual({
      ok: true,
      effort: undefined,
    });
  });

  test("lists the accepted levels when the value is not one of them", () => {
    const parsed = parseReasoningEffort("highest");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a rejection");
    expect(parsed.message).toBe(
      `Expected one of: ${REASONING_EFFORT_ORDER.join(", ")}`,
    );
  });
});
