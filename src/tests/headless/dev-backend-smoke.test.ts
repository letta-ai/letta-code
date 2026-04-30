import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createIsolatedCliTestEnv } from "../testProcessEnv";

const projectRoot = process.cwd();

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const env = createIsolatedCliTestEnv({
    LETTA_DEBUG: "0",
    DISABLE_AUTOUPDATER: "1",
  });
  delete env.LETTA_API_KEY;
  delete env.LETTA_BASE_URL;
  delete env.LETTA_API_BASE;
  delete env.LETTA_AGENT_ID;
  delete env.LETTA_CONVERSATION_ID;

  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", "dev", ...args], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
          `Timeout waiting for dev backend smoke. stdout: ${stdout}, stderr: ${stderr}`,
        ),
      );
    }, 30000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code });
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("headless dev backend smoke", () => {
  test("runs one-shot headless without API credentials", async () => {
    const result = await runCli([
      "-p",
      "ping",
      "--agent",
      "agent-fake",
      "--dev-backend",
      "fake-headless",
      "--permission-mode",
      "plan",
      "--no-skills",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pong");
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Failed to connect to Letta server");
  });
});
