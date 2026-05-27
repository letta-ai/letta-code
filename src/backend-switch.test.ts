import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const projectRoot = process.cwd();

async function runCliWithEnv(
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const env = createIsolatedCliTestEnv({
      LETTA_DEBUG: "0",
      ...extraEnv,
    });
    const proc = spawn(
      "bun",
      [
        "--loader=.md:text",
        "--loader=.mdx:text",
        "--loader=.txt:text",
        "run",
        "src/index.ts",
        ...args,
      ],
      {
        cwd: projectRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
          `Timeout waiting for CLI. stdout: ${stdout}, stderr: ${stderr}`,
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

describe("headless backend switches", () => {
  test("explicit local backend does not silently replace the ambient agent", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "lc-local-backend-switch-"),
    );
    try {
      const result = await runCliWithEnv(
        [
          "--backend",
          "local",
          "-p",
          "Reply with exactly: should-not-run",
          "--max-turns",
          "1",
          "--no-skills",
        ],
        {
          LETTA_LOCAL_BACKEND_EXPERIMENTAL: "true",
          LETTA_LOCAL_BACKEND_DIR: storageDir,
          LETTA_AGENT_ID: "agent-ambient-remote",
          AGENT_ID: "agent-ambient-remote",
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("should-not-run");
      expect(result.stderr).toContain(
        "Active agent agent-ambient-remote is not available on the local backend.",
      );
      expect(result.stderr).toContain(
        "will not silently switch to a different cwd-local agent",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
