import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanupOldOverflowFiles,
  ensureOverflowDirectory,
  getOverflowDirectory,
  getOverflowStats,
  OVERFLOW_CONFIG,
  writeOverflowFile,
} from "../../tools/impl/overflow";

describe("overflow utilities", () => {
  const testWorkingDir = "/test/project/path";
  let overflowDir: string;

  beforeEach(() => {
    overflowDir = getOverflowDirectory(testWorkingDir);
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(overflowDir)) {
      const files = fs.readdirSync(overflowDir);
      for (const file of files) {
        fs.unlinkSync(path.join(overflowDir, file));
      }
      // Try to remove the directory (will fail if not empty)
      try {
        fs.rmdirSync(overflowDir);
      } catch {
        // Directory not empty, that's OK
      }
    }
  });

  describe("OVERFLOW_CONFIG", () => {
    test("has expected default values", () => {
      expect(OVERFLOW_CONFIG.ENABLED).toBeDefined();
      expect(OVERFLOW_CONFIG.MIDDLE_TRUNCATE).toBeDefined();
    });
  });

  describe("getOverflowDirectory", () => {
    test("generates consistent directory path", () => {
      const dir1 = getOverflowDirectory(testWorkingDir);
      const dir2 = getOverflowDirectory(testWorkingDir);

      expect(dir1).toBe(dir2);
    });

    test("creates path under ~/.letta", () => {
      const dir = getOverflowDirectory(testWorkingDir);
      const homeDir = os.homedir();

      expect(dir).toContain(path.join(homeDir, ".letta"));
    });

    test("sanitizes working directory path", () => {
      const dir = getOverflowDirectory("/path/with spaces/and:colons");

      // The sanitized segment (derived from input path) should have no spaces/colons
      // On Windows, the full path contains C:\ so we check the segment, not full path
      const sanitizedSegment = "path_with_spaces_and_colons";
      expect(dir).toContain(sanitizedSegment);
      expect(sanitizedSegment).not.toContain(" ");
      expect(sanitizedSegment).not.toContain(":");
    });
  });

  describe("ensureOverflowDirectory", () => {
    test("creates directory if it doesn't exist", () => {
      const dir = ensureOverflowDirectory(testWorkingDir);

      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    test("returns existing directory without error", () => {
      const dir1 = ensureOverflowDirectory(testWorkingDir);
      const dir2 = ensureOverflowDirectory(testWorkingDir);

      expect(dir1).toBe(dir2);
      expect(fs.existsSync(dir1)).toBe(true);
    });
  });

  describe("writeOverflowFile", () => {
    test("writes content to a file", () => {
      const content = "Test content for overflow file";
      const filePath = writeOverflowFile(content, testWorkingDir, "TestTool");

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
    });

    test("generates unique filenames", () => {
      const content = "Test content";
      const file1 = writeOverflowFile(content, testWorkingDir, "TestTool");
      const file2 = writeOverflowFile(content, testWorkingDir, "TestTool");

      expect(file1).not.toBe(file2);
    });

    test("includes tool name in filename", () => {
      const content = "Test content";
      const filePath = writeOverflowFile(
        content,
        testWorkingDir,
        "MyCustomTool",
      );

      expect(path.basename(filePath)).toContain("mycustomtool");
    });

    test("handles large content", () => {
      const largeContent = "x".repeat(100_000);
      const filePath = writeOverflowFile(
        largeContent,
        testWorkingDir,
        "TestTool",
      );

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(largeContent);
    });
  });

  describe("cleanupOldOverflowFiles", () => {
    test("removes files older than specified age", async () => {
      // Create a test file
      const content = "Test content";
      const filePath = writeOverflowFile(content, testWorkingDir, "TestTool");

      // Manually set the file's mtime to be old
      const oldTime = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
      fs.utimesSync(filePath, new Date(oldTime), new Date(oldTime));

      // Clean up files older than 24 hours
      const deletedCount = cleanupOldOverflowFiles(
        testWorkingDir,
        24 * 60 * 60 * 1000,
      );

      expect(deletedCount).toBe(1);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test("preserves recent files", () => {
      const content = "Test content";
      const filePath = writeOverflowFile(content, testWorkingDir, "TestTool");

      // Clean up files older than 24 hours (file is recent)
      const deletedCount = cleanupOldOverflowFiles(
        testWorkingDir,
        24 * 60 * 60 * 1000,
      );

      expect(deletedCount).toBe(0);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    test("returns 0 if directory doesn't exist", () => {
      const nonExistentDir = "/non/existent/directory";
      const deletedCount = cleanupOldOverflowFiles(
        nonExistentDir,
        24 * 60 * 60 * 1000,
      );

      expect(deletedCount).toBe(0);
    });

    test("skips subdirectories without crashing", () => {
      // Create a test file and a subdirectory
      const content = "Test content";
      const filePath = writeOverflowFile(content, testWorkingDir, "TestTool");

      // Create a subdirectory in the overflow dir
      const subDir = path.join(path.dirname(filePath), "subdir");
      fs.mkdirSync(subDir, { recursive: true });

      // Make the file old
      const oldTime = Date.now() - 48 * 60 * 60 * 1000;
      fs.utimesSync(filePath, new Date(oldTime), new Date(oldTime));

      // Cleanup should skip the directory and only delete the file
      const deletedCount = cleanupOldOverflowFiles(
        testWorkingDir,
        24 * 60 * 60 * 1000,
      );

      expect(deletedCount).toBe(1);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(subDir)).toBe(true);

      // Clean up the subdir
      fs.rmdirSync(subDir);
    });
  });

  describe("getOverflowStats", () => {
    test("returns correct stats for empty directory", () => {
      ensureOverflowDirectory(testWorkingDir);
      const stats = getOverflowStats(testWorkingDir);

      expect(stats.exists).toBe(true);
      expect(stats.fileCount).toBe(0);
      expect(stats.totalSize).toBe(0);
    });

    test("returns correct stats for directory with files", () => {
      const content1 = "Test content 1";
      const content2 = "Test content 2 is longer";

      writeOverflowFile(content1, testWorkingDir, "Tool1");
      writeOverflowFile(content2, testWorkingDir, "Tool2");

      const stats = getOverflowStats(testWorkingDir);

      expect(stats.exists).toBe(true);
      expect(stats.fileCount).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    test("returns correct stats for non-existent directory", () => {
      const nonExistentDir = "/non/existent/directory";
      const stats = getOverflowStats(nonExistentDir);

      expect(stats.exists).toBe(false);
      expect(stats.fileCount).toBe(0);
      expect(stats.totalSize).toBe(0);
    });
  });
});
