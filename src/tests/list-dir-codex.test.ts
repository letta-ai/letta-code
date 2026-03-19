import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { list_dir } from "../tools/impl/ListDirCodex.js";
import { DIRECTORY_LIMIT_ENV } from "../utils/directoryLimits";

const DIRECTORY_LIMIT_ENV_KEYS = Object.values(DIRECTORY_LIMIT_ENV);
const ORIGINAL_DIRECTORY_ENV = Object.fromEntries(
  DIRECTORY_LIMIT_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

function restoreDirectoryLimitEnv(): void {
  for (const key of DIRECTORY_LIMIT_ENV_KEYS) {
    const original = ORIGINAL_DIRECTORY_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("list_dir codex tool", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    restoreDirectoryLimitEnv();

    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs = [];
  });

  test("uses env overrides for per-folder child cap", async () => {
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxChildrenPerDir] = "3";

    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 10; i++) {
      structure[`file-${String(i).padStart(4, "0")}.txt`] = String(i);
    }
    const dir = await createStructure(structure);

    const result = await list_dir({ dir_path: dir, limit: 200, depth: 2 });

    expect(result.content).toContain("… (7 more entries)");
    expect(result.content).not.toContain("file-0009.txt");
  });

  async function setupTempDir(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "list-dir-test-"));
    tempDirs.push(tempDir);
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

    // First line is "Absolute path: ..."
    const lines = result.content.split("\n");
    expect(lines[0]).toContain("Absolute path:");

    // Entries should start at ccc.txt after skipping aaa/bbb
    expect(result.content).toContain("ccc.txt");
    expect(result.content).toContain("ddd.txt");
    expect(result.content).not.toContain("aaa.txt");
    expect(result.content).not.toContain("bbb.txt");
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

    expect(result.content).toContain(
      "More entries available. Use offset=3 to continue.",
    );
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

  test("accepts relative paths", async () => {
    const relDir = await fs.mkdtemp(
      path.join(process.cwd(), "list-dir-relative-test-"),
    );
    await fs.writeFile(path.join(relDir, "file.txt"), "content");

    const relativePath = path.relative(process.cwd(), relDir);
    expect(path.isAbsolute(relativePath)).toBe(false);

    const result = await list_dir({ dir_path: relativePath });

    expect(result.content).toContain(`Absolute path: ${relDir}`);
    expect(result.content).toContain("file.txt");

    await fs.rm(relDir, { recursive: true, force: true });
  });

  test("throws error for offset < 1", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, offset: 0 })).rejects.toThrow(
      "offset must be a positive integer (1-indexed)",
    );
  });

  test("throws error for non-integer offset", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, offset: 1.5 })).rejects.toThrow(
      "offset must be a positive integer (1-indexed)",
    );
  });

  test("throws error for very large offset", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, offset: 10_001 })).rejects.toThrow(
      "offset must be less than or equal to 10,000",
    );
  });

  test("throws error for limit < 1", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, limit: 0 })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  test("throws error for non-integer limit", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, limit: 2.5 })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  test("throws error for depth < 1", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, depth: 0 })).rejects.toThrow(
      "depth must be a positive integer",
    );
  });

  test("throws error for non-integer depth", async () => {
    const dir = await setupTempDir();
    await expect(list_dir({ dir_path: dir, depth: 1.2 })).rejects.toThrow(
      "depth must be a positive integer",
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

  test("caps oversized limit/depth requests and reports capping", async () => {
    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 260; i++) {
      structure[`file-${String(i).padStart(4, "0")}.txt`] = String(i);
    }

    const dir = await createStructure(structure);
    const result = await list_dir({
      dir_path: dir,
      limit: 1000,
      depth: 99,
    });

    expect(result.content).toContain(
      "[Request capped: limit=1000->200, depth=99->5]",
    );
    expect(result.content).toMatch(/… \([\d,]+ more entries\)/);
    expect(result.content).toContain(
      "More entries may exist beyond the current truncated view.",
    );
  });

  test("truncates large folders in-place with omission markers", async () => {
    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 60; i++) {
      structure[`file-${String(i).padStart(4, "0")}.txt`] = String(i);
    }

    const dir = await createStructure(structure);
    const result = await list_dir({ dir_path: dir, limit: 200, depth: 2 });

    expect(result.content).toContain("… (10 more entries)");
    expect(result.content).not.toContain("file-0059.txt");
  });

  test("truncates nested folder children in-place", async () => {
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxChildrenPerDir] = "5";

    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 60; i++) {
      structure[`parent/child-${String(i).padStart(4, "0")}.txt`] = String(i);
    }

    const dir = await createStructure(structure);
    const result = await list_dir({ dir_path: dir, limit: 200, depth: 3 });

    expect(result.content).toContain("parent/");
    expect(result.content).toContain("  child-0000.txt");
    expect(result.content).toContain("  … (55 more entries)");
    expect(result.content).not.toContain("child-0059.txt");
  });

  test("offset paginates truncated view with stable omission marker ordering", async () => {
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxChildrenPerDir] = "3";

    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 10; i++) {
      structure[`file-${String(i).padStart(4, "0")}.txt`] = String(i);
    }

    const dir = await createStructure(structure);
    const result = await list_dir({
      dir_path: dir,
      offset: 4,
      limit: 2,
      depth: 2,
    });

    const lines = result.content.split("\n").slice(1);
    expect(lines[0]).toBe("… (7 more entries)");
    expect(result.content).toContain(
      "More entries may exist beyond the current truncated view.",
    );
  });

  test("offset beyond truncated view is rejected", async () => {
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxChildrenPerDir] = "3";

    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 10; i++) {
      structure[`file-${String(i).padStart(4, "0")}.txt`] = String(i);
    }

    const dir = await createStructure(structure);

    await expect(
      list_dir({ dir_path: dir, offset: 5, limit: 1, depth: 2 }),
    ).rejects.toThrow(
      "offset exceeds available entries in current view (max offset: 4)",
    );
  });

  test("does not traverse subdirectories omitted by per-folder cap", async () => {
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxChildrenPerDir] = "1";

    const dir = await createStructure({
      "alpha/visible.txt": "visible",
      "zeta/deep/hidden.txt": "hidden",
    });

    const result = await list_dir({ dir_path: dir, limit: 200, depth: 5 });

    expect(result.content).toContain("alpha/");
    expect(result.content).toContain("  visible.txt");
    expect(result.content).toContain("… (1 more entries)");
    expect(result.content).not.toContain("zeta/");
    expect(result.content).not.toContain("hidden.txt");
  });

  test("uses env overrides for list_dir caps", async () => {
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxLimit] = "3";
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxDepth] = "2";
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxOffset] = "99";
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxCollectedEntries] = "99";

    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 25; i++) {
      structure[`file-${String(i).padStart(4, "0")}.txt`] = String(i);
    }
    const dir = await createStructure(structure);

    const result = await list_dir({ dir_path: dir, limit: 50, depth: 10 });

    expect(result.content).toContain(
      "[Request capped: limit=50->3, depth=10->2]",
    );
    expect(result.content).toContain(
      "More entries available. Use offset=4 to continue.",
    );
  });

  test("falls back to defaults for invalid list_dir env overrides", async () => {
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxLimit] = "invalid";
    process.env[DIRECTORY_LIMIT_ENV.listDirMaxDepth] = "-1";

    const structure: Record<string, string | null> = {};
    for (let i = 0; i < 260; i++) {
      structure[`file-${String(i).padStart(4, "0")}.txt`] = String(i);
    }
    const dir = await createStructure(structure);

    const result = await list_dir({ dir_path: dir, limit: 1000, depth: 99 });

    // Defaults should still apply when env values are invalid.
    expect(result.content).toContain(
      "[Request capped: limit=1000->200, depth=99->5]",
    );
  });
});
