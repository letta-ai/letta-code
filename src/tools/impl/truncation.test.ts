import { describe, expect, test } from "bun:test";
import {
  LIMITS,
  truncateArray,
  truncateByChars,
  truncateByLines,
} from "./truncation";

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
      expect(result.content).toContain("a".repeat(500));
      expect(result.content).toContain(
        "[Output truncated after 500 characters: exceeded limit.]",
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
  });

  describe("truncateByLines", () => {
    test("does not truncate when under line limit", () => {
      const text = "line1\nline2\nline3";
      const result = truncateByLines(text, 10, undefined, "Test");

      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(text);
      expect(result.originalLineCount).toBe(3);
      expect(result.linesShown).toBe(3);
    });

    test("truncates when exceeding line limit", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
      const text = lines.join("\n");
      const result = truncateByLines(text, 50, undefined, "Test");

      expect(result.wasTruncated).toBe(true);
      expect(result.originalLineCount).toBe(100);
      expect(result.linesShown).toBe(50);
      expect(result.content).toContain("Line 1");
      expect(result.content).toContain("Line 50");
      expect(result.content).not.toContain("Line 51");
      expect(result.content).toContain("showing 50 of 100 lines");
    });

    test("truncates long lines when maxCharsPerLine specified", () => {
      const text = "short\n" + "a".repeat(1000) + "\nshort";
      const result = truncateByLines(text, 10, 500, "Test");

      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain("short");
      expect(result.content).toContain("a".repeat(500));
      expect(result.content).toContain("... [line truncated]");
      expect(result.content).toContain(
        "Some lines exceeded 500 characters and were truncated",
      );
    });

    test("handles both line count and character truncation", () => {
      const lines = Array.from(
        { length: 100 },
        (_, i) => `Line ${i + 1}: ${"x".repeat(2000)}`,
      );
      const text = lines.join("\n");
      const result = truncateByLines(text, 50, 1000, "Test");

      expect(result.wasTruncated).toBe(true);
      expect(result.originalLineCount).toBe(100);
      expect(result.linesShown).toBe(50);
      expect(result.content).toContain("showing 50 of 100 lines");
      expect(result.content).toContain(
        "Some lines exceeded 1,000 characters and were truncated",
      );
    });

    test("exactly at line limit does not truncate", () => {
      const text = "line1\nline2\nline3";
      const result = truncateByLines(text, 3, undefined, "Test");

      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(text);
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
      expect(result.content).toContain("item50");
      expect(result.content).not.toContain("item51");
      expect(result.content).toContain("showing 50 of 100 items");
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
      expect(LIMITS.READ_MAX_LINES).toBe(2_000);
      expect(LIMITS.READ_MAX_CHARS_PER_LINE).toBe(2_000);
      expect(LIMITS.GREP_OUTPUT_CHARS).toBe(10_000);
      expect(LIMITS.GLOB_MAX_FILES).toBe(2_000);
      expect(LIMITS.LS_MAX_ENTRIES).toBe(1_000);
    });
  });
});
