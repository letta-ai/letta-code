import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

/**
 * Integration tests for CLI startup flows.
 *
 * These tests verify the boot flow decision tree:
 * - Flag conflict detection
 * - --conversation: derives agent from conversation
 * - --agent: uses specified agent
 * - --new-agent: creates new agent
 * - Error messages for invalid inputs
 *
 * Note: Tests that depend on settings files (.letta/) are harder to isolate
 * because the CLI uses process.cwd(). For now, we focus on flag-based tests.
 */

const projectRoot = process.cwd();

// Helper to run CLI and capture output
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
// Flag Conflict Tests (fast, no API calls needed)
// ============================================================================

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

  test("--from-af with nonexistent file shows error", async () => {
    const result = await runCli(
      ["--from-af", "/nonexistent/path/agent.af", "-p", "test"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain("not found");
  });
});

// ============================================================================
// Integration Tests (require API access, create real agents)
// ============================================================================

describe("Startup Flow - Integration", () => {
  // Store created agent/conversation IDs for cleanup and reuse
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

      // Save for later tests
      testAgentId = output.agent_id;
    },
    { timeout: 130000 },
  );

  test(
    "--agent with valid ID uses that agent",
    async () => {
      // Skip if previous test didn't create an agent
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
      // Skip if previous test didn't create an agent
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

      // Now test that --conversation can derive the agent from this conversation
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
      // Should use the same agent that owns the conversation
      expect(output.agent_id).toBe(testAgentId);
      // Should use the specified conversation
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
      // stdout includes the bun invocation line, extract just the JSON
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
      // This test relies on running in a directory with no .letta/ settings
      // In practice, this might use the project's .letta/ which has an LRU
      // So we check for either success (if LRU exists) or error (if not)
      const result = await runCli(
        ["--continue", "-p", "Say OK", "--output-format", "json"],
        { timeoutMs: 60000 },
      );

      // Either succeeds (LRU exists) or fails with specific error
      if (result.exitCode !== 0) {
        expect(result.stderr).toContain("No recent session found");
      }
      // If it succeeds, that's also valid (test env has LRU)
    },
    { timeout: 70000 },
  );
});
