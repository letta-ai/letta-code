import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import {
  clampRawToolReturn,
  clampToolReturnContent,
} from "@/tools/impl/tool-return-clamp";
import { LIMITS } from "@/tools/impl/truncation";

function cleanupOverflowFile(clamped: string): void {
  const match = clamped.match(/Full output written to: (.+\.txt)/);
  if (match?.[1] && fs.existsSync(match[1])) {
    fs.unlinkSync(match[1]);
  }
}

describe("clampToolReturnContent", () => {
  test("returns short strings unchanged", () => {
    const content = "regular tool output";
    expect(clampToolReturnContent(content, "SomeTool")).toBe(content);
  });

  test("passes through output already clamped by a per-tool 30K limit", () => {
    // Bash/Task clamp to 30K then append a notice; the backstop must not
    // re-truncate that.
    const alreadyClamped = `${"b".repeat(30_000)}\n\n[Output truncated: showing 30,000 of 100,000 characters.]`;
    expect(clampToolReturnContent(alreadyClamped, "Bash")).toBe(alreadyClamped);
  });

  test("clamps oversized strings and writes an overflow file", () => {
    const big = "a".repeat(LIMITS.TOOL_RETURN_MAX_CHARS + 50_000);
    const clamped = clampToolReturnContent(big, "SomeMcpTool") as string;

    expect(clamped.length).toBeLessThan(LIMITS.TOOL_RETURN_MAX_CHARS + 1_000);
    expect(clamped).toContain("[Output truncated: showing");

    const match = clamped.match(/Full output written to: (.+\.txt)/);
    expect(match).toBeDefined();
    if (match?.[1]) {
      expect(fs.existsSync(match[1])).toBe(true);
      expect(fs.readFileSync(match[1], "utf-8").length).toBe(big.length);
    }
    cleanupOverflowFile(clamped);
  });

  test("clamps text blocks in multimodal content, leaves images untouched", () => {
    const image: ImageContent = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc123" },
    };
    const bigText: TextContent = {
      type: "text",
      text: "c".repeat(LIMITS.TOOL_RETURN_MAX_CHARS + 10_000),
    };

    const result = clampToolReturnContent([bigText, image], "SomeTool");

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      const [text, img] = result;
      if (text?.type !== "text") throw new Error("expected text block");
      expect(text.text.length).toBeLessThan(
        LIMITS.TOOL_RETURN_MAX_CHARS + 1_000,
      );
      expect(text.text).toContain("[Output truncated: showing");
      expect(img).toEqual(image);
      cleanupOverflowFile(text.text);
    }
  });
});

describe("clampRawToolReturn", () => {
  test("passes short strings through unchanged", () => {
    expect(clampRawToolReturn("regular tool output", "SomeTool")).toBe(
      "regular tool output",
    );
  });

  test("stringifies non-string payloads and maps nullish to empty string", () => {
    expect(clampRawToolReturn({ stdout: "hi" }, "SomeTool")).toBe(
      '{"stdout":"hi"}',
    );
    expect(clampRawToolReturn(null, "SomeTool")).toBe("");
    expect(clampRawToolReturn(undefined, "SomeTool")).toBe("");
  });

  test("clamps oversized payloads, keeping beginning and end", () => {
    const big = `START-${"a".repeat(LIMITS.TOOL_RETURN_MAX_CHARS + 50_000)}-END`;
    const clamped = clampRawToolReturn(big, "SomeCloudTool");

    expect(clamped.length).toBeLessThan(LIMITS.TOOL_RETURN_MAX_CHARS + 1_000);
    expect(clamped).toContain("[Output truncated: showing");
    expect(clamped.startsWith("START-")).toBe(true);
    expect(clamped).toContain("-END");
    cleanupOverflowFile(clamped);
  });

  test("passes through returns already clamped by the tool manager", () => {
    // The manager's backstop appends a notice (and overflow path) on top of
    // the TOOL_RETURN_MAX_CHARS excerpt; the transcript clamp must not
    // truncate that a second time.
    const alreadyClamped = `${"a".repeat(LIMITS.TOOL_RETURN_MAX_CHARS)}\n\n[Output truncated: showing 32,000 of 100,000 characters.]\n[Full output written to: /tmp/overflow.txt]`;
    expect(clampRawToolReturn(alreadyClamped, "SomeTool")).toBe(alreadyClamped);
  });
});
