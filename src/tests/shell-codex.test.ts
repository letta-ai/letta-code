import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shell } from "../tools/impl/Shell.js";

const isWindows = process.platform === "win32";

describe("shell codex tool", () => {
  let tempDir: string;

  async function setupTempDir(): Promise<string> {
    if (!tempDir) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-test-"));
    }
    return tempDir;
  }

  test("executes simple command with execvp-style args", async () => {
    const result = await shell({
      command: ["echo", "hello", "world"],
    });

    expect(result.output).toBe("hello world");
    expect(result.stdout).toContain("hello world");
    expect(result.stderr.length).toBe(0);
  });

  test("executes bash -lc style command", async () => {
    const result = await shell({
      command: ["bash", "-lc", "echo 'hello from bash'"],
    });

    expect(result.output).toContain("hello from bash");
  });

  test("handles arguments with spaces correctly", async () => {
    // This is the key test for execvp semantics - args with spaces
    // should NOT be split
    const result = await shell({
      command: ["echo", "hello world", "foo bar"],
    });

    expect(result.output).toBe("hello world foo bar");
  });

  test.skipIf(isWindows)("respects workdir parameter", async () => {
    const dir = await setupTempDir();
    // Resolve symlinks (macOS /var -> /private/var)
    const resolvedDir = await fs.realpath(dir);

    const result = await shell({
      command: ["pwd"],
      workdir: dir,
    });

    expect(result.output).toBe(resolvedDir);
  });

  test.skipIf(isWindows)("captures stderr output", async () => {
    const result = await shell({
      command: ["bash", "-c", "echo 'error message' >&2"],
    });

    expect(result.stderr).toContain("error message");
  });

  test.skipIf(isWindows)("handles non-zero exit codes", async () => {
    const result = await shell({
      command: ["bash", "-c", "exit 1"],
    });

    // Should still resolve (not reject), but output may indicate failure
    expect(result).toBeDefined();
  });

  test.skipIf(isWindows)(
    "handles command with output in both stdout and stderr",
    async () => {
      const result = await shell({
        command: ["bash", "-c", "echo 'stdout'; echo 'stderr' >&2"],
      });

      expect(result.stdout).toContain("stdout");
      expect(result.stderr).toContain("stderr");
      expect(result.output).toContain("stdout");
      expect(result.output).toContain("stderr");
    },
  );

  test("times out long-running commands", async () => {
    await expect(
      shell({
        command: ["sleep", "10"],
        timeout_ms: 100,
      }),
    ).rejects.toThrow("timed out");
  });

  test("throws error for empty command array", async () => {
    await expect(shell({ command: [] })).rejects.toThrow(
      "command must be a non-empty array",
    );
  });

  test("throws error for missing command", async () => {
    // @ts-expect-error Testing invalid input
    await expect(shell({})).rejects.toThrow();
  });

  test.skipIf(isWindows)("handles relative workdir", async () => {
    // Set USER_CWD to a known location
    const originalCwd = process.env.USER_CWD;
    const dir = await setupTempDir();
    process.env.USER_CWD = dir;

    // Create a subdirectory
    const subdir = path.join(dir, "subdir");
    await fs.mkdir(subdir, { recursive: true });
    // Resolve symlinks (macOS /var -> /private/var)
    const resolvedSubdir = await fs.realpath(subdir);

    try {
      const result = await shell({
        command: ["pwd"],
        workdir: "subdir",
      });

      expect(result.output).toBe(resolvedSubdir);
    } finally {
      if (originalCwd !== undefined) {
        process.env.USER_CWD = originalCwd;
      } else {
        delete process.env.USER_CWD;
      }
    }
  });

  test.skipIf(isWindows)(
    "handles command that produces multi-line output",
    async () => {
      const result = await shell({
        command: ["bash", "-c", "echo 'line1'; echo 'line2'; echo 'line3'"],
      });

      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
      expect(result.stdout).toContain("line3");
      expect(result.stdout.length).toBe(3);
    },
  );

  test("handles special characters in arguments", async () => {
    const result = await shell({
      command: ["echo", "$HOME", "$(whoami)", "`date`"],
    });

    // Since we're using execvp-style (not shell expansion),
    // these should be treated as literal strings
    expect(result.output).toContain("$HOME");
    expect(result.output).toContain("$(whoami)");
    expect(result.output).toContain("`date`");
  });

  test.skipIf(isWindows)("handles file operations with bash -lc", async () => {
    const dir = await setupTempDir();
    const testFile = path.join(dir, "test-output.txt");

    await shell({
      command: ["bash", "-lc", `echo 'test content' > "${testFile}"`],
    });

    const content = await fs.readFile(testFile, "utf8");
    expect(content.trim()).toBe("test content");
  });
});
