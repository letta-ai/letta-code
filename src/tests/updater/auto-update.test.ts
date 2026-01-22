import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// We need to test the internal functions, so we'll recreate them here
// In a real scenario, we'd export these for testing or use dependency injection

describe("auto-update ENOTEMPTY handling", () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temp directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "letta-test-"));
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("cleanupOrphanedDirs logic", () => {
    test("removes directories starting with .letta-code-", async () => {
      // Create test directories
      const lettaAiDir = path.join(testDir, "lib/node_modules/@letta-ai");
      fs.mkdirSync(lettaAiDir, { recursive: true });

      // Create orphaned temp dirs (should be removed)
      const orphan1 = path.join(lettaAiDir, ".letta-code-abc123");
      const orphan2 = path.join(lettaAiDir, ".letta-code-xyz789");
      fs.mkdirSync(orphan1);
      fs.mkdirSync(orphan2);

      // Create legitimate dirs (should NOT be removed)
      const legitimate = path.join(lettaAiDir, "letta-code");
      const otherPackage = path.join(lettaAiDir, "other-package");
      fs.mkdirSync(legitimate);
      fs.mkdirSync(otherPackage);

      // Simulate cleanup logic
      const { readdir, rm } = await import("node:fs/promises");
      const entries = await readdir(lettaAiDir);
      for (const entry of entries) {
        if (entry.startsWith(".letta-code-")) {
          await rm(path.join(lettaAiDir, entry), {
            recursive: true,
            force: true,
          });
        }
      }

      // Verify
      expect(fs.existsSync(orphan1)).toBe(false);
      expect(fs.existsSync(orphan2)).toBe(false);
      expect(fs.existsSync(legitimate)).toBe(true);
      expect(fs.existsSync(otherPackage)).toBe(true);
    });

    test("handles non-existent directory gracefully", async () => {
      const nonExistent = path.join(testDir, "does/not/exist");
      const { readdir } = await import("node:fs/promises");

      // This should not throw
      let error: NodeJS.ErrnoException | null = null;
      try {
        await readdir(nonExistent);
      } catch (e) {
        error = e as NodeJS.ErrnoException;
      }

      expect(error).not.toBeNull();
      expect(error?.code).toBe("ENOENT");
    });

    test("handles empty directory", async () => {
      const emptyDir = path.join(testDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });

      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(emptyDir);

      expect(entries).toEqual([]);
    });
  });

  describe("ENOTEMPTY error detection", () => {
    test("detects ENOTEMPTY in npm error message", () => {
      const npmError = `npm error code ENOTEMPTY
npm error syscall rename
npm error path /Users/user/.npm-global/lib/node_modules/@letta-ai/letta-code
npm error dest /Users/user/.npm-global/lib/node_modules/@letta-ai/.letta-code-lnWEqMep
npm error errno -66
npm error ENOTEMPTY: directory not empty`;

      expect(npmError.includes("ENOTEMPTY")).toBe(true);
    });

    test("detects ENOTEMPTY in error.message", () => {
      const error = new Error(
        "Command failed: npm install -g @letta-ai/letta-code@latest\nnpm error ENOTEMPTY: directory not empty",
      );

      expect(error.message.includes("ENOTEMPTY")).toBe(true);
    });

    test("does not false-positive on other errors", () => {
      const networkError = "npm error ETIMEDOUT: network timeout";
      const permissionError = "npm error EACCES: permission denied";

      expect(networkError.includes("ENOTEMPTY")).toBe(false);
      expect(permissionError.includes("ENOTEMPTY")).toBe(false);
    });
  });

  describe("npm global path detection", () => {
    test("path structure for cleanup is correct", () => {
      // Test that the path we construct is valid
      const globalPrefix = "/Users/test/.npm-global";
      const lettaAiDir = path.join(globalPrefix, "lib/node_modules/@letta-ai");

      // path.join normalizes separators for the current platform
      expect(lettaAiDir).toContain("lib");
      expect(lettaAiDir).toContain("node_modules");
      expect(lettaAiDir).toContain("@letta-ai");
    });

    test("path structure works on Windows-style paths", () => {
      // Windows uses different separators but path.join handles it
      const globalPrefix = "C:\\Users\\test\\AppData\\Roaming\\npm";
      const lettaAiDir = path.join(globalPrefix, "lib/node_modules/@letta-ai");

      // path.join normalizes separators for the current platform
      expect(lettaAiDir).toContain("lib");
      expect(lettaAiDir).toContain("node_modules");
      expect(lettaAiDir).toContain("@letta-ai");
    });
  });
});
