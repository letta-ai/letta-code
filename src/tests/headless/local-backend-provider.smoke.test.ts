import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedCliTestEnv } from "../testProcessEnv";

const projectRoot = process.cwd();
const providerSmokeEnabled = process.env.LETTA_LOCAL_PROVIDER_SMOKE === "true";

async function runLocalProviderCli(
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const storageDir = await mkdtemp(join(tmpdir(), "lc-local-provider-"));
  const env = createIsolatedCliTestEnv({
    LETTA_DEBUG: "0",
    DISABLE_AUTOUPDATER: "1",
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "true",
    LETTA_LOCAL_BACKEND_DIR: storageDir,
    ...extraEnv,
  });
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  delete env.LETTA_API_KEY;
  delete env.LETTA_BASE_URL;
  delete env.LETTA_API_BASE;
  delete env.LETTA_AGENT_ID;
  delete env.LETTA_CONVERSATION_ID;

  try {
    return await new Promise((resolve, reject) => {
      const proc = spawn(
        "bun",
        [
          "run",
          "dev",
          "-p",
          "Reply with exactly: LOCAL_PROVIDER_SMOKE_OK",
          "--new-agent",
          "--permission-mode",
          "plan",
          "--no-skills",
          "--no-memfs",
          "--memfs-startup",
          "skip",
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
            `Timeout waiting for local provider smoke. stdout: ${stdout}, stderr: ${stderr}`,
          ),
        );
      }, 90000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ stdout, stderr, exitCode: code });
      });
      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

describe.skipIf(!providerSmokeEnabled)("headless local provider smoke", () => {
  test.skipIf(!process.env.OPENAI_API_KEY)(
    "runs local OpenAI Responses headless without Letta API credentials",
    async () => {
      const result = await runLocalProviderCli({
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: undefined,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LOCAL_PROVIDER_SMOKE_OK");
      expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
      expect(result.stderr).not.toContain("Failed to connect to Letta server");
    },
  );

  test.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "runs local Anthropic headless without Letta API credentials",
    async () => {
      const result = await runLocalProviderCli({
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LOCAL_PROVIDER_SMOKE_OK");
      expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
      expect(result.stderr).not.toContain("Failed to connect to Letta server");
    },
  );
});
