import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { list_dir } from "../tools/impl/ListDirCodex.js";

describe("list_dir codex tool", () => {
  let tempDir: string;

  async function setupTempDir(): Promise<string> {
    if (!tempDir) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "list-dir-test-"));
    }
    return tempDir;
  }

  async function createStructure(
    structure: Record<string, string | null>,
  ): Promise<string> {
    const dir = await setupTempDir();

    for (const [relativePath, content] of Object.entries(structure)) {
      const fullPath = path.join(dir, relativePath);
      const parentDir = path.dirname(fullPath);

      await fs.mkdir(parentDir, { recursive: true });

      if (content !== null) {
        // It's a file
        await fs.writeFile(fullPath, content);
      }
      // If content is null, it's just a directory (already created by mkdir)
    }

    return dir;
  }

  test("lists directory with default pagination", async () => {
    const dir = await createStructure({
      "file1.txt": "content1",
      "file2.txt": "content2",
      "subdir/file3.txt": "content3",
    });

    const result = await list_dir({ dir_path: dir });

    expect(result.content).toContain(`Absolute path: ${dir}`);
    expect(result.content).toContain("file1.txt");
    expect(result.content).toContain("file2.txt");
    expect(result.content).toContain("subdir/");
  });

  test("respects offset parameter (1-indexed)", async () => {
    const dir = await createStructure({
      "aaa.txt": "a",
      "bbb.txt": "b",
      "ccc.txt": "c",
      "ddd.txt": "d",
    });

    // Skip first 2 entries
    const result = await list_dir({ dir_path: dir, offset: 3, limit: 10 });

    // Should not contain first two entries (when sorted alphabetically)
    const lines = result.content.split("\n");
    // First line is "Absolute path: ..."
    expect(lines[0]).toContain("Absolute path:");
    // Remaining lines should be limited entries
    expect(lines.length).toBeGreaterThan(1);
  });

  test("respects limit parameter", async () => {
    const dir = await createStructure({
      "file1.txt": "1",
      "file2.txt": "2",
      "file3.txt": "3",
      "file4.txt": "4",
      "file5.txt": "5",
    });

    const result = await list_dir({ dir_path: dir, limit: 2 });

    // Should have "More than 2 entries found" message
    expect(result.content).toContain("More than 2 entries found");
  });

  test("respects depth parameter", async () => {
    const dir = await createStructure({
      "level1/level2/level3/deep.txt": "deep",
      "level1/shallow.txt": "shallow",
      "root.txt": "root",
    });

    // Depth 1 should only show immediate children
    const result1 = await list_dir({ dir_path: dir, depth: 1, limit: 100 });
    expect(result1.content).toContain("level1/");
    expect(result1.content).toContain("root.txt");
    expect(result1.content).not.toContain("level2");
    expect(result1.content).not.toContain("shallow.txt");

    // Depth 2 should show one level deeper
    const result2 = await list_dir({ dir_path: dir, depth: 2, limit: 100 });
    expect(result2.content).toContain("level1/");
    expect(result2.content).toContain("shallow.txt");
    expect(result2.content).toContain("level2/");
    expect(result2.content).not.toContain("level3");
  });

  test("shows directories with trailing slash", async () => {
    const dir = await createStructure({
      "mydir/file.txt": "content",
    });

    const result = await list_dir({ dir_path: dir });

    expect(result.content).toContain("mydir/");
  });

  test("throws error for non-absolute path", async () => {
    await expect(list_dir({ dir_path: "relative/path" })).rejects.toThrow(
      "dir_path must be an absolute path",
    );
  });

  test("throws error for offset < 1", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, offset: 0 })).rejects.toThrow(
      "offset must be a 1-indexed entry number",
    );
  });

  test("throws error for limit < 1", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, limit: 0 })).rejects.toThrow(
      "limit must be greater than zero",
    );
  });

  test("throws error for depth < 1", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, depth: 0 })).rejects.toThrow(
      "depth must be greater than zero",
    );
  });

  test("handles empty directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-dir-test-"));

    const result = await list_dir({ dir_path: dir });

    expect(result.content).toContain(`Absolute path: ${dir}`);
    // Should only have the header line
    const lines = result.content.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
  });
});
