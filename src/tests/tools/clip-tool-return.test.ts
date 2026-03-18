import { describe, expect, test } from "bun:test";
import { clipToolReturn } from "../../tools/manager";

describe("clipToolReturn", () => {
  test("clips long single-line output and appends ellipsis", () => {
    const long = "A".repeat(1200);
    const clipped = clipToolReturn(long);

    expect(clipped.length).toBeLessThan(400);
    expect(clipped.endsWith("…")).toBe(true);
  });

  test("clips by line count for multiline output", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const clipped = clipToolReturn(text, 3, 10_000);

    expect(clipped).toContain("line1");
    expect(clipped).toContain("line2");
    expect(clipped).toContain("line3");
    expect(clipped).not.toContain("line4");
    expect(clipped.endsWith("…")).toBe(true);
  });

  test("does not clip user-denial reasons", () => {
    const denial = `Error: request to call tool denied. User reason: ${"B".repeat(800)}`;
    const clipped = clipToolReturn(denial);

    expect(clipped).toBe(denial);
  });
});
