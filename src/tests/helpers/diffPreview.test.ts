import { describe, expect, it } from "bun:test";
import type {
  AdvancedDiffFallback,
  AdvancedDiffSuccess,
  AdvancedDiffUnpreviewable,
} from "../../cli/helpers/diff";
import { toDiffPreview } from "../../helpers/diffPreview";

describe("toDiffPreview", () => {
  it("converts an AdvancedDiffSuccess to an advanced DiffPreview", () => {
    const input: AdvancedDiffSuccess = {
      mode: "advanced",
      fileName: "foo.ts",
      oldStr: "const a = 1;\n",
      newStr: "const a = 2;\n",
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [{ raw: "-const a = 1;" }, { raw: "+const a = 2;" }],
        },
      ],
    };

    const result = toDiffPreview(input);

    expect(result.mode).toBe("advanced");
    if (result.mode !== "advanced") throw new Error("unreachable");

    expect(result.fileName).toBe("foo.ts");
    // oldStr/newStr must NOT appear on the wire type
    expect("oldStr" in result).toBe(false);
    expect("newStr" in result).toBe(false);

    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0];
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.oldLines).toBe(1); // one remove
    expect(hunk?.newLines).toBe(1); // one add
    expect(hunk?.lines).toEqual([
      { type: "remove", content: "const a = 1;" },
      { type: "add", content: "const a = 2;" },
    ]);
  });

  it("computes oldLines/newLines correctly for mixed hunks", () => {
    const input: AdvancedDiffSuccess = {
      mode: "advanced",
      fileName: "test.ts",
      oldStr: "",
      newStr: "",
      hunks: [
        {
          oldStart: 5,
          newStart: 5,
          lines: [
            { raw: " context line" },
            { raw: "-removed line 1" },
            { raw: "-removed line 2" },
            { raw: "+added line" },
            { raw: " more context" },
          ],
        },
      ],
    };

    const result = toDiffPreview(input);
    if (result.mode !== "advanced") throw new Error("unreachable");

    const hunk = result.hunks[0];
    // context: 2 (contributes to both), remove: 2, add: 1
    expect(hunk?.oldLines).toBe(4); // 2 context + 2 remove
    expect(hunk?.newLines).toBe(3); // 2 context + 1 add
  });

  it("parses empty raw lines as context", () => {
    const input: AdvancedDiffSuccess = {
      mode: "advanced",
      fileName: "empty.ts",
      oldStr: "",
      newStr: "",
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [{ raw: "" }],
        },
      ],
    };

    const result = toDiffPreview(input);
    if (result.mode !== "advanced") throw new Error("unreachable");

    expect(result.hunks[0]?.lines[0]).toEqual({
      type: "context",
      content: "",
    });
  });

  it("converts fallback results with fileName", () => {
    const input: AdvancedDiffFallback = {
      mode: "fallback",
      reason: "File not readable",
    };

    const result = toDiffPreview(input, "myfile.ts");
    expect(result).toEqual({
      mode: "fallback",
      fileName: "myfile.ts",
      reason: "File not readable",
    });
  });

  it("converts unpreviewable results with fileName", () => {
    const input: AdvancedDiffUnpreviewable = {
      mode: "unpreviewable",
      reason: "Edit not found in file",
    };

    const result = toDiffPreview(input, "target.ts");
    expect(result).toEqual({
      mode: "unpreviewable",
      fileName: "target.ts",
      reason: "Edit not found in file",
    });
  });

  it("uses 'unknown' fileName when no override provided for fallback/unpreviewable", () => {
    const fallback: AdvancedDiffFallback = {
      mode: "fallback",
      reason: "File not readable",
    };
    expect(toDiffPreview(fallback).fileName).toBe("unknown");

    const unpreviewable: AdvancedDiffUnpreviewable = {
      mode: "unpreviewable",
      reason: "reason",
    };
    expect(toDiffPreview(unpreviewable).fileName).toBe("unknown");
  });

  it("allows fileName override on advanced results", () => {
    const input: AdvancedDiffSuccess = {
      mode: "advanced",
      fileName: "original.ts",
      oldStr: "",
      newStr: "",
      hunks: [],
    };

    const result = toDiffPreview(input, "overridden.ts");
    expect(result.fileName).toBe("overridden.ts");
  });
});
