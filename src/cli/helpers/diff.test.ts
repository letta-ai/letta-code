import { describe, expect, test } from "bun:test";
import { computeAdvancedDiff } from "@/cli/helpers/diff";

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
