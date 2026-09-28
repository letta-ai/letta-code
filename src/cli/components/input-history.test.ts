import { describe, expect, it } from "bun:test";
import { appendInputHistory, MAX_INPUT_HISTORY_ENTRIES } from "./input-history";

describe("appendInputHistory", () => {
  it("appends entries below the cap", () => {
    expect(appendInputHistory(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("skips duplicates of the most recent entry", () => {
    expect(appendInputHistory(["a"], "a")).toEqual(["a"]);
    expect(appendInputHistory(["a"], "a ")).toEqual(["a"]);
    expect(appendInputHistory(["a"], "b")).toEqual(["a", "b"]);
  });

  it("keeps only the most recent entries once the cap is exceeded", () => {
    const full = Array.from({ length: MAX_INPUT_HISTORY_ENTRIES }, (_, i) =>
      String(i),
    );
    const next = appendInputHistory(full, "newest");
    expect(next).toHaveLength(MAX_INPUT_HISTORY_ENTRIES);
    expect(next[0]).toBe("1");
    expect(next[next.length - 1]).toBe("newest");
  });
});
