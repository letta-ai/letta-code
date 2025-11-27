import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { grep_files } from "../tools/impl/GrepFiles.js";

describe("grep_files codex tool", () => {
  async function createTempDirWithFiles(
    files: Record<string, string>,
  ): Promise<string> {
    // Create a fresh temp directory for each test
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-files-test-"));

    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, relativePath);
      const parentDir = path.dirname(fullPath);

      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    return dir;
  }

  test("finds files matching pattern", async () => {
    const dir = await createTempDirWithFiles({
      "file1.txt": "hello world",
      "file2.txt": "goodbye world",
      "file3.txt": "no match here",
    });

    const result = await grep_files({ pattern: "world", path: dir });

    expect(result.output).toContain("file1.txt");
    expect(result.output).toContain("file2.txt");
    expect(result.output).not.toContain("file3.txt");
    expect(result.files).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("respects include glob pattern", async () => {
    const dir = await createTempDirWithFiles({
      "code.ts": "function hello() {}",
      "code.js": "function hello() {}",
      "readme.md": "hello documentation",
    });

    const result = await grep_files({
      pattern: "hello",
      path: dir,
      include: "*.ts",
    });

    expect(result.output).toContain("code.ts");
    expect(result.output).not.toContain("code.js");
    expect(result.output).not.toContain("readme.md");
    expect(result.files).toBe(1);
  });

  test("respects limit parameter", async () => {
    const dir = await createTempDirWithFiles({
      "file01.txt": "match",
      "file02.txt": "match",
      "file03.txt": "match",
      "file04.txt": "match",
      "file05.txt": "match",
    });

    const result = await grep_files({
      pattern: "match",
      path: dir,
      limit: 3,
    });

    expect(result.files).toBe(3);
    expect(result.truncated).toBe(true);

    // Count files in output (header line + file paths)
    const lines = result.output.split("\n").filter((l) => l.trim() !== "");
    // Header line "Found 3 files (truncated from 5)" + 3 file paths = 4 lines
    expect(lines.length).toBe(4);
  });

  test("returns truncated: false when under limit", async () => {
    const dir = await createTempDirWithFiles({
      "file1.txt": "match",
      "file2.txt": "match",
    });

    const result = await grep_files({
      pattern: "match",
      path: dir,
      limit: 10,
    });

    expect(result.files).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("handles no matches gracefully", async () => {
    const dir = await createTempDirWithFiles({
      "file1.txt": "hello",
      "file2.txt": "world",
    });

    const result = await grep_files({
      pattern: "nonexistent_unique_pattern_xyz",
      path: dir,
    });

    // When no matches, output may be empty or undefined
    const hasNoFiles =
      !result.files ||
      result.files === 0 ||
      result.output === "" ||
      !result.output;
    expect(hasNoFiles).toBe(true);
  });

  test("searches recursively by default", async () => {
    const dir = await createTempDirWithFiles({
      "root.txt": "findme",
      "subdir/nested.txt": "findme",
      "subdir/deep/deeper.txt": "findme",
    });

    const result = await grep_files({
      pattern: "findme",
      path: dir,
    });

    expect(result.output).toContain("root.txt");
    expect(result.output).toContain("nested.txt");
    expect(result.output).toContain("deeper.txt");
    expect(result.files).toBe(3);
  });

  test("supports regex patterns", async () => {
    const dir = await createTempDirWithFiles({
      "file1.txt": "error: something failed",
      "file2.txt": "Error: another failure",
      "file3.txt": "no errors here",
    });

    // Case-insensitive pattern via regex
    const result = await grep_files({
      pattern: "[Ee]rror:",
      path: dir,
    });

    expect(result.output).toContain("file1.txt");
    expect(result.output).toContain("file2.txt");
    expect(result.output).not.toContain("file3.txt");
  });

  test("handles empty pattern gracefully", async () => {
    const dir = await createTempDirWithFiles({
      "file1.txt": "content",
    });

    // Empty pattern might not throw, but should handle gracefully
    const result = await grep_files({
      pattern: "",
      path: dir,
    });

    // Just verify it doesn't crash - behavior may vary
    expect(result).toBeDefined();
  });
});
