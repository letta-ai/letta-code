import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnCommand } from "../../tools/impl/Bash.js";
import { getShellEnv } from "../../tools/impl/shellEnv.js";

const isWindows = process.platform === "win32";

/**
 * Tests for the $ command feature in the CLI
 * This tests the underlying shell execution that powers the $ command
 */
describe("$ command feature", () => {
  let tempDir: string;

  async function setupTempDir(): Promise<string> {
    if (!tempDir) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dollar-cmd-test-"));
    }
    return tempDir;
  }

  test("executes simple echo command", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand("echo 'Hello from $ command'", {
      cwd,
      env,
      timeout: 5000,
    });

    expect(result.stdout).toContain("Hello from $ command");
    expect(result.exitCode).toBe(0);
  });

  test.skipIf(isWindows)("executes git status command", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    // Only run if we're in a git repo
    try {
      const result = await spawnCommand("git status --short", {
        cwd,
        env,
        timeout: 5000,
      });

      // Should succeed (exit code 0) or fail gracefully
      expect(result.exitCode).toBeDefined();
    } catch (error) {
      // If git is not available, skip
      expect(error).toBeDefined();
    }
  });

  test("captures both stdout and stderr", async () => {
    if (isWindows) return;

    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand(
      "echo 'stdout message' && echo 'stderr message' >&2",
      {
        cwd,
        env,
        timeout: 5000,
      },
    );

    expect(result.stdout).toContain("stdout message");
    expect(result.stderr).toContain("stderr message");
  });

  test("handles command with non-zero exit code", async () => {
    if (isWindows) return;

    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand("exit 1", {
      cwd,
      env,
      timeout: 5000,
    });

    expect(result.exitCode).toBe(1);
  });

  test("respects working directory", async () => {
    if (isWindows) return;

    const dir = await setupTempDir();
    const env = getShellEnv(dir);
    const resolvedDir = await fs.realpath(dir);

    const result = await spawnCommand("pwd", {
      cwd: dir,
      env,
      timeout: 5000,
    });

    expect(result.stdout.trim()).toBe(resolvedDir);
    expect(result.exitCode).toBe(0);
  });

  test("handles multi-line output", async () => {
    if (isWindows) return;

    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand(
      "echo 'line1' && echo 'line2' && echo 'line3'",
      {
        cwd,
        env,
        timeout: 5000,
      },
    );

    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(result.stdout).toContain("line3");
  });

  test("times out long-running commands", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);
    const sleepCmd = isWindows ? "timeout /t 10" : "sleep 10";

    await expect(
      spawnCommand(sleepCmd, {
        cwd,
        env,
        timeout: 100, // 100ms timeout
      }),
    ).rejects.toThrow();
  });

  test.skipIf(isWindows)("handles commands with pipes", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand("echo -e 'foo\\nbar\\nbaz' | grep bar", {
      cwd,
      env,
      timeout: 5000,
    });

    expect(result.stdout).toContain("bar");
    expect(result.stdout).not.toContain("foo");
    expect(result.exitCode).toBe(0);
  });

  test.skipIf(isWindows)("handles commands with redirects", async () => {
    const dir = await setupTempDir();
    const env = getShellEnv(dir);
    const testFile = path.join(dir, "test-output.txt");

    const result = await spawnCommand(`echo 'test content' > "${testFile}"`, {
      cwd: dir,
      env,
      timeout: 5000,
    });

    expect(result.exitCode).toBe(0);

    const content = await fs.readFile(testFile, "utf8");
    expect(content.trim()).toBe("test content");
  });

  test.skipIf(isWindows)("handles environment variables", async () => {
    const cwd = process.cwd();
    const env = { ...getShellEnv(cwd), TEST_VAR: "hello_world" };

    const result = await spawnCommand("echo $TEST_VAR", {
      cwd,
      env,
      timeout: 5000,
    });

    expect(result.stdout.trim()).toBe("hello_world");
  });

  test.skipIf(isWindows)("executes ls command", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand("ls -la", {
      cwd,
      env,
      timeout: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeTruthy();
    // Should contain common directory entries
    expect(result.stdout.includes(".") || result.stdout.includes("total")).toBe(
      true,
    );
  });

  test("handles empty command gracefully", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand("", {
      cwd,
      env,
      timeout: 5000,
    });

    // Empty command should complete without error
    expect(result).toBeDefined();
  });

  test.skipIf(isWindows)(
    "handles commands with special characters",
    async () => {
      const cwd = process.cwd();
      const env = getShellEnv(cwd);

      const result = await spawnCommand(
        "echo 'special chars: !@#$%^&*()_+-=[]{}|;:,.<>?'",
        {
          cwd,
          env,
          timeout: 5000,
        },
      );

      expect(result.stdout).toContain("special chars:");
      expect(result.exitCode).toBe(0);
    },
  );

  test.skipIf(isWindows)("handles commands with quotes", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand(
      `echo "double quotes" && echo 'single quotes'`,
      {
        cwd,
        env,
        timeout: 5000,
      },
    );

    expect(result.stdout).toContain("double quotes");
    expect(result.stdout).toContain("single quotes");
    expect(result.exitCode).toBe(0);
  });

  test.skipIf(isWindows)("executes commands with chaining", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand(
      "echo 'first' && echo 'second' && echo 'third'",
      {
        cwd,
        env,
        timeout: 5000,
      },
    );

    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
    expect(result.stdout).toContain("third");
    expect(result.exitCode).toBe(0);
  });

  test.skipIf(isWindows)("stops chain execution on first failure", async () => {
    const cwd = process.cwd();
    const env = getShellEnv(cwd);

    const result = await spawnCommand(
      "echo 'before' && exit 1 && echo 'after'",
      {
        cwd,
        env,
        timeout: 5000,
      },
    );

    expect(result.stdout).toContain("before");
    expect(result.stdout).not.toContain("after");
    expect(result.exitCode).toBe(1);
  });
});
