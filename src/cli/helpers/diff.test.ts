import { describe, expect, test } from "bun:test";
import {
  computeAdvancedDiff,
  releaseDiffFileContents,
  storeReleasedDiffs,
} from "@/cli/helpers/diff";

describe("computeAdvancedDiff", () => {
  test("shows whitespace-only tab/space edits", () => {
    const result = computeAdvancedDiff(
      {
        kind: "write",
        filePath: "/tmp/example.ts",
        content: "  foo();\n",
      },
      { oldStrOverride: "\tfoo();\n" },
    );

    expect(result.mode).toBe("advanced");
    if (result.mode !== "advanced") throw new Error("unreachable");

    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.lines).toEqual([
      { raw: "-\tfoo();" },
      { raw: "+  foo();" },
    ]);
  });
});

describe("releaseDiffFileContents", () => {
  test("drops full file contents but keeps renderable hunks", () => {
    const result = computeAdvancedDiff(
      { kind: "write", filePath: "/tmp/big.ts", content: "a\nb\nc\n" },
      { oldStrOverride: "a\nx\nc\n" },
    );
    if (result.mode !== "advanced") throw new Error("unreachable");
    expect(result.oldStr.length).toBeGreaterThan(0);

    const released = releaseDiffFileContents(result);

    expect(released.oldStr).toBe("");
    expect(released.newStr).toBe("");
    expect(released.hunks).toEqual(result.hunks);
    expect(released.fileName).toBe(result.fileName);
    // Original object is not mutated
    expect(result.oldStr.length).toBeGreaterThan(0);
  });

  test("returns the same object when contents are already empty", () => {
    const result = computeAdvancedDiff(
      { kind: "write", filePath: "/tmp/new.ts", content: "hello\n" },
      { oldStrOverride: "" },
    );
    if (result.mode !== "advanced") throw new Error("unreachable");
    const cleared = { ...result, oldStr: "", newStr: "" };
    expect(releaseDiffFileContents(cleared)).toBe(cleared);
  });
});

describe("storeReleasedDiffs", () => {
  test("stores only content-free diffs and tolerates undefined", () => {
    const target = new Map();
    expect(() => storeReleasedDiffs(target, undefined)).not.toThrow();

    const result = computeAdvancedDiff(
      { kind: "write", filePath: "/tmp/big.ts", content: "new contents\n" },
      { oldStrOverride: "old contents\n" },
    );
    if (result.mode !== "advanced") throw new Error("unreachable");

    storeReleasedDiffs(target, new Map([["tc-1", result]]));

    const stored = target.get("tc-1");
    expect(stored.oldStr).toBe("");
    expect(stored.newStr).toBe("");
    expect(stored.hunks.length).toBeGreaterThan(0);
  });
});
