import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

/**
 * Startup flow tests that validate flag conflict handling.
 *
 * These must remain runnable in fork PR CI (no secrets), so they should not
 * require a working Letta server or LETTA_API_KEY.
 */

const projectRoot = process.cwd();

async function runCli(
  args: string[],
  options: {
    timeoutMs?: number;
    expectExit?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { timeoutMs = 30000, expectExit } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", "dev", ...args], {
      cwd: projectRoot,
      // Mark as subagent to prevent polluting user's LRU settings
      env: { ...process.env, LETTA_CODE_AGENT_ROLE: "subagent" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `Timeout after ${timeoutMs}ms. stdout: ${stdout}, stderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (expectExit !== undefined && code !== expectExit) {
        reject(
          new Error(
            `Expected exit code ${expectExit}, got ${code}. stdout: ${stdout}, stderr: ${stderr}`,
          ),
        );
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("Startup Flow - Flag Conflicts", () => {
  test("--conversation conflicts with --agent", async () => {
    const result = await runCli(
      ["--conversation", "conv-123", "--agent", "agent-123"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain(
      "--conversation cannot be used with --agent",
    );
  });

  test("--conversation conflicts with --new-agent", async () => {
    const result = await runCli(["--conversation", "conv-123", "--new-agent"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain(
      "--conversation cannot be used with --new-agent",
    );
  });

  test("--conversation conflicts with --resume", async () => {
    const result = await runCli(["--conversation", "conv-123", "--resume"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain(
      "--conversation cannot be used with --resume",
    );
  });

  test("--conversation conflicts with --continue", async () => {
    const result = await runCli(["--conversation", "conv-123", "--continue"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain(
      "--conversation cannot be used with --continue",
    );
  });

  test("--conversation conflicts with --from-af", async () => {
    const result = await runCli(
      ["--conversation", "conv-123", "--from-af", "test.af"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain(
      "--conversation cannot be used with --from-af",
    );
  });

  test("--conversation conflicts with --name", async () => {
    const result = await runCli(
      ["--conversation", "conv-123", "--name", "MyAgent"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain(
      "--conversation cannot be used with --name",
    );
  });
});
