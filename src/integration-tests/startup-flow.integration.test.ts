import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

/**
 * Startup flow integration tests.
 *
 * These spawn the real CLI and require LETTA_API_KEY to be set.
 * They are executed in CI only for push to main / trusted PRs (non-forks).
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

// ============================================================================
// Invalid Input Tests (require API calls but fail fast)
// ============================================================================

describe("Startup Flow - Invalid Inputs", () => {
  test(
    "--agent with nonexistent ID shows error",
    async () => {
      const result = await runCli(
        ["--agent", "agent-definitely-does-not-exist-12345", "-p", "test"],
        { expectExit: 1, timeoutMs: 60000 },
      );
      expect(result.stderr).toContain("not found");
    },
    { timeout: 70000 },
  );

  test(
    "--conversation with nonexistent ID shows error",
    async () => {
      const result = await runCli(
        [
          "--conversation",
          "conversation-definitely-does-not-exist-12345",
          "-p",
          "test",
        ],
        { expectExit: 1, timeoutMs: 60000 },
      );
      expect(result.stderr).toContain("not found");
    },
    { timeout: 70000 },
  );

  test("--import with nonexistent file shows error", async () => {
    const result = await runCli(
      ["--import", "/nonexistent/path/agent.af", "-p", "test"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain("not found");
  });
});

// ============================================================================
// Integration Tests (require API access, create real agents)
// ============================================================================

describe("Startup Flow - Integration", () => {
  let testAgentId: string | null = null;

  test(
    "--new-agent creates agent and responds",
    async () => {
      const result = await runCli(
        [
          "--new-agent",
          "-m",
          "haiku",
          "-p",
          "Say OK and nothing else",
          "--output-format",
          "json",
        ],
        { timeoutMs: 120000 },
      );

      expect(result.exitCode).toBe(0);
      // stdout includes the bun invocation line, extract just the JSON
      const jsonStart = result.stdout.indexOf("{");
      const output = JSON.parse(result.stdout.slice(jsonStart));
      expect(output.agent_id).toBeDefined();
      expect(output.result).toBeDefined();

      testAgentId = output.agent_id;
    },
    { timeout: 130000 },
  );

  test(
    "--agent with valid ID uses that agent",
    async () => {
      if (!testAgentId) {
        console.log("Skipping: no test agent available");
        return;
      }

      const result = await runCli(
        [
          "--agent",
          testAgentId,
          "-m",
          "haiku",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        { timeoutMs: 120000 },
      );

      expect(result.exitCode).toBe(0);
      const jsonStart = result.stdout.indexOf("{");
      const output = JSON.parse(result.stdout.slice(jsonStart));
      expect(output.agent_id).toBe(testAgentId);
    },
    { timeout: 130000 },
  );

  test(
    "--conversation with valid ID derives agent and uses conversation",
    async () => {
      if (!testAgentId) {
        console.log("Skipping: no test agent available");
        return;
      }

      // First, create a real conversation with --new (since --new-agent uses "default")
      const createResult = await runCli(
        [
          "--agent",
          testAgentId,
          "--new",
          "-m",
          "haiku",
          "-p",
          "Say CREATED",
          "--output-format",
          "json",
        ],
        { timeoutMs: 120000 },
      );
      expect(createResult.exitCode).toBe(0);
      const createJsonStart = createResult.stdout.indexOf("{");
      const createOutput = JSON.parse(
        createResult.stdout.slice(createJsonStart),
      );
      const realConversationId = createOutput.conversation_id;
      expect(realConversationId).toBeDefined();
      expect(realConversationId).not.toBe("default");

      const result = await runCli(
        [
          "--conversation",
          realConversationId,
          "-m",
          "haiku",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        { timeoutMs: 120000 },
      );

      expect(result.exitCode).toBe(0);
      const jsonStart = result.stdout.indexOf("{");
      const output = JSON.parse(result.stdout.slice(jsonStart));
      expect(output.agent_id).toBe(testAgentId);
      expect(output.conversation_id).toBe(realConversationId);
    },
    { timeout: 180000 },
  );

  test(
    "--new-agent with --init-blocks none creates minimal agent",
    async () => {
      const result = await runCli(
        [
          "--new-agent",
          "--init-blocks",
          "none",
          "-m",
          "haiku",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        { timeoutMs: 120000 },
      );

      expect(result.exitCode).toBe(0);
      const jsonStart = result.stdout.indexOf("{");
      const output = JSON.parse(result.stdout.slice(jsonStart));
      expect(output.agent_id).toBeDefined();
    },
    { timeout: 130000 },
  );
});

// ============================================================================
// --continue Tests (depend on LRU state, harder to isolate)
// ============================================================================

describe("Startup Flow - Continue Flag", () => {
  test(
    "--continue with no LRU shows error",
    async () => {
      const result = await runCli(
        ["--continue", "-p", "Say OK", "--output-format", "json"],
        {
          timeoutMs: 60000,
        },
      );

      // Either succeeds (LRU exists) or fails with specific error
      if (result.exitCode !== 0) {
        expect(result.stderr).toContain("No recent session found");
      }
    },
    { timeout: 70000 },
  );
});
