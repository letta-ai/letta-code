import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateSystemPromptSize,
  estimateSystemPromptTokensFromMemoryDir,
  estimateSystemTokens,
  SYSTEM_PROMPT_BYTES_PER_TOKEN,
} from "../../utils/systemPromptSize";

describe("estimateSystemTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateSystemTokens("")).toBe(0);
  });

  test("divides bytes by BYTES_PER_TOKEN and ceilings", () => {
    // 4 bytes of ASCII -> 1 token
    expect(estimateSystemTokens("abcd")).toBe(1);
    // 5 bytes -> ceil(5/4) = 2
    expect(estimateSystemTokens("abcde")).toBe(2);
  });

  test("uses UTF-8 byte length for multi-byte characters", () => {
    // "é" is 2 bytes in UTF-8
    expect(Buffer.byteLength("é", "utf8")).toBe(2);
    expect(estimateSystemTokens("é")).toBe(
      Math.ceil(2 / SYSTEM_PROMPT_BYTES_PER_TOKEN),
    );
  });
});

describe("estimateSystemPromptSize", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "system-prompt-size-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("returns 0 total and empty files when memory dir missing", () => {
    const result = estimateSystemPromptSize(join(tmpRoot, "nonexistent"));
    expect(result.total).toBe(0);
    expect(result.files).toEqual([]);
  });

  test("returns 0 total when system/ does not exist", () => {
    // tmpRoot exists but has no system/
    const result = estimateSystemPromptSize(tmpRoot);
    expect(result.total).toBe(0);
    expect(result.files).toEqual([]);
  });

  test("sums tokens across files in system/", () => {
    mkdirSync(join(tmpRoot, "system"), { recursive: true });
    writeFileSync(join(tmpRoot, "system", "persona.md"), "abcd"); // 4 bytes -> 1 tok
    writeFileSync(join(tmpRoot, "system", "other.md"), "abcdefgh"); // 8 -> 2 tok

    const { total, files } = estimateSystemPromptSize(tmpRoot);
    expect(total).toBe(3);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path).sort()).toEqual([
      "system/other.md",
      "system/persona.md",
    ]);
  });

  test("walks nested directories", () => {
    mkdirSync(join(tmpRoot, "system", "project"), { recursive: true });
    mkdirSync(join(tmpRoot, "system", "human", "prefs"), { recursive: true });
    writeFileSync(join(tmpRoot, "system", "persona.md"), "a".repeat(8));
    writeFileSync(
      join(tmpRoot, "system", "project", "architecture.md"),
      "b".repeat(16),
    );
    writeFileSync(
      join(tmpRoot, "system", "human", "prefs", "coding.md"),
      "c".repeat(12),
    );

    const { total, files } = estimateSystemPromptSize(tmpRoot);
    expect(total).toBe(2 + 4 + 3); // 8/4 + 16/4 + 12/4
    expect(files).toHaveLength(3);
  });

  test("skips hidden files and directories", () => {
    mkdirSync(join(tmpRoot, "system", ".git"), { recursive: true });
    writeFileSync(join(tmpRoot, "system", ".git", "config"), "a".repeat(100));
    writeFileSync(join(tmpRoot, "system", ".hidden.md"), "a".repeat(100));
    writeFileSync(join(tmpRoot, "system", "visible.md"), "abcd");

    const { total, files } = estimateSystemPromptSize(tmpRoot);
    expect(total).toBe(1);
    expect(files).toEqual([{ path: "system/visible.md", tokens: 1 }]);
  });

  test("ignores non-markdown files", () => {
    mkdirSync(join(tmpRoot, "system"), { recursive: true });
    writeFileSync(join(tmpRoot, "system", "persona.md"), "abcd");
    writeFileSync(join(tmpRoot, "system", "config.json"), "a".repeat(100));
    writeFileSync(join(tmpRoot, "system", "notes.txt"), "a".repeat(100));

    const { total, files } = estimateSystemPromptSize(tmpRoot);
    expect(total).toBe(1);
    expect(files).toEqual([{ path: "system/persona.md", tokens: 1 }]);
  });
});

describe("estimateSystemPromptTokensFromMemoryDir (backward-compat)", () => {
  test("returns just the total", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "system-prompt-size-"));
    try {
      mkdirSync(join(tmpRoot, "system"), { recursive: true });
      writeFileSync(join(tmpRoot, "system", "persona.md"), "abcd");
      expect(estimateSystemPromptTokensFromMemoryDir(tmpRoot)).toBe(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
