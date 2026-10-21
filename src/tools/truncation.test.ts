import { describe, expect, test } from "bun:test";
import {
  LIMITS,
  truncateArray,
  truncateByChars,
} from "@/tools/impl/truncation";

describe("truncation utilities", () => {
  describe("truncateByChars", () => {
    test("does not truncate when under limit", () => {
      const text = "Hello, world!";
      const result = truncateByChars(text, 100, "Test");

      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(text);
    });

    test("truncates when exceeding limit", () => {
      const text = "a".repeat(1000);
      const result = truncateByChars(text, 500, "Test");

      expect(result.wasTruncated).toBe(true);
      // With middle truncation, we should see beginning and end
      expect(result.content).toContain("a".repeat(250)); // beginning
      expect(result.content).toContain("characters omitted");
      expect(result.content).toContain(
        "[Output truncated: showing 500 of 1,000 characters.]",
      );
      expect(result.content.length).toBeGreaterThan(500); // Due to notice
    });

    test("exactly at limit does not truncate", () => {
      const text = "a".repeat(500);
      const result = truncateByChars(text, 500, "Test");

      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(text);
    });

    test("includes correct character count in notice", () => {
      const text = "x".repeat(2000);
      const result = truncateByChars(text, 1000, "Test");

      expect(result.content).toContain("1,000 characters");
    });

    test("ignores previewChars when no overflow file was written", () => {
      const text = `${"a".repeat(1000)}END`;
      const result = truncateByChars(text, 500, "Test", {
        previewChars: 100,
        useMiddleTruncation: true,
      });

      expect(result.overflowPath).toBeUndefined();
      expect(result.content).toStartWith("a".repeat(250));
      expect(result.content).toContain("END");
      expect(result.content).toContain(
        "[Output truncated: showing 500 of 1,003 characters.]",
      );
    });
  });

  describe("truncateArray", () => {
    test("does not truncate when under limit", () => {
      const items = ["item1", "item2", "item3"];
      const formatter = (arr: string[]) => arr.join("\n");
      const result = truncateArray(items, 10, formatter, "items");

      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe("item1\nitem2\nitem3");
    });

    test("truncates when exceeding limit", () => {
      const items = Array.from({ length: 100 }, (_, i) => `item${i + 1}`);
      const formatter = (arr: string[]) => arr.join("\n");
      const result = truncateArray(items, 50, formatter, "items");

      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain("item1");
      // With middle truncation, we show first 25 and last 25
      expect(result.content).toContain("item25");
      expect(result.content).toContain("item76");
      expect(result.content).toContain("item100");
      expect(result.content).toContain("showing 50 of 100 items");
      expect(result.content).toContain("omitted from middle");
    });

    test("exactly at limit does not truncate", () => {
      const items = ["a", "b", "c"];
      const formatter = (arr: string[]) => arr.join(", ");
      const result = truncateArray(items, 3, formatter, "entries");

      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe("a, b, c");
    });

    test("uses custom item type in notice", () => {
      const items = Array.from({ length: 1000 }, (_, i) => `/file${i}.txt`);
      const formatter = (arr: string[]) => arr.join("\n");
      const result = truncateArray(items, 100, formatter, "files");

      expect(result.content).toContain("showing 100 of 1,000 files");
    });
  });

  describe("LIMITS constants", () => {
    test("has expected values", () => {
      expect(LIMITS.BASH_OUTPUT_CHARS).toBe(30_000);
      expect(LIMITS.BASH_FAILURE_OUTPUT_CHARS).toBe(10_000);
      expect(LIMITS.HOOK_OUTPUT_CHARS).toBe(10_000);
      expect(LIMITS.OVERFLOW_PREVIEW_CHARS).toBe(2_000);
      expect(LIMITS.READ_MAX_LINES).toBe(2_000);
      expect(LIMITS.READ_MAX_CHARS_PER_LINE).toBe(2_000);
      expect(LIMITS.READ_OUTPUT_CHARS).toBe(30_000);
      expect(LIMITS.GREP_OUTPUT_CHARS).toBe(10_000);
      expect(LIMITS.GLOB_MAX_FILES).toBe(2_000);
      expect(LIMITS.LS_MAX_ENTRIES).toBe(1_000);
      // Backstop must sit above per-tool clamps so already-clamped output
      // (30K + truncation notice) passes through unchanged.
      expect(LIMITS.TOOL_RETURN_MAX_CHARS).toBeGreaterThan(
        LIMITS.BASH_OUTPUT_CHARS + 500,
      );
    });
  });
});
