import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createIsolatedCliTestEnv } from "../tests/testProcessEnv";
import {
  formatAttemptDiagnostics,
  formatCapturedOutput,
} from "./processDiagnostics";

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
    retryOnTimeouts?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { timeoutMs = 30000, expectExit, retryOnTimeouts = 1 } = options;
  const failedAttempts: Array<{ attempt: number; message: string }> = [];

  const runOnce = () =>
    new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolve, reject) => {
        const proc = spawn("bun", ["run", "dev", "--no-memfs", ...args], {
          cwd: projectRoot,
          env: createIsolatedCliTestEnv(),
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
              `Timeout after ${timeoutMs}ms.\n${formatCapturedOutput({
                stdout,
                stderr,
                extra: {
                  args: args.join(" "),
                  saw_result_payload:
                    stdout.includes('"type":"result"') ||
                    stdout.includes('"type": "result"'),
                },
              })}`,
            ),
          );
        }, timeoutMs);

        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (expectExit !== undefined && code !== expectExit) {
            reject(
              new Error(
                `Expected exit code ${expectExit}, got ${code}.\n${formatCapturedOutput(
                  {
                    stdout,
                    stderr,
                    extra: {
                      args: args.join(" "),
                      saw_result_payload:
                        stdout.includes('"type":"result"') ||
                        stdout.includes('"type": "result"'),
                    },
                  },
                )}`,
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
      },
    );

  let attempt = 0;
  while (true) {
    try {
      return await runOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedAttempts.push({
        attempt: attempt + 1,
        message,
      });
      const isTimeoutError =
        error instanceof Error && error.message.includes("Timeout after");
      if (!isTimeoutError || attempt >= retryOnTimeouts) {
        throw new Error(
          failedAttempts.length === 1
            ? message
            : `${message}\n${formatAttemptDiagnostics(
                failedAttempts.slice(0, -1),
              )}`,
        );
      }
      attempt += 1;
      // CI API calls can be transiently slow; retry once to reduce flakiness.
      console.warn(
        `[startup-flow] retrying after timeout (${attempt}/${retryOnTimeouts}) args=${args.join(" ")}`,
      );
    }
  }
}

function parseJsonFromStdout(stdout: string) {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("No JSON object found in stdout");
  }
  return JSON.parse(stdout.slice(jsonStart)) as Record<string, unknown>;
}

async function runCliJson(
  args: string[],
  options: {
    timeoutMs?: number;
    retryOnTimeouts?: number;
    retryOnParseErrors?: number;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  output: Record<string, unknown>;
}> {
  const { retryOnParseErrors = 1, ...runCliOptions } = options;
  let attempt = 0;
  const parseFailures: Array<{ attempt: number; message: string }> = [];

  while (true) {
    const result = await runCli(args, runCliOptions);
    try {
      return {
        ...result,
        output: parseJsonFromStdout(result.stdout),
      };
    } catch (error) {
      const message = `Failed to parse JSON stdout.\n${formatCapturedOutput({
        stdout: result.stdout,
        stderr: result.stderr,
        extra: {
          args: args.join(" "),
          parse_error: error instanceof Error ? error.message : String(error),
        },
      })}`;
      parseFailures.push({
        attempt: attempt + 1,
        message,
      });
      if (attempt >= retryOnParseErrors) {
        throw new Error(formatAttemptDiagnostics(parseFailures));
      }

      attempt += 1;
      console.warn(
        `[startup-flow] retrying after parse failure (${attempt}/${retryOnParseErrors}) args=${args.join(" ")}`,
      );
    }
  }
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
      const result = await runCliJson(
        [
          "--new-agent",
          "-m",
          "sonnet-4.6-low",
          "-p",
          "Say OK and nothing else",
          "--output-format",
          "json",
        ],
        { timeoutMs: 180000 },
      );

      expect(result.exitCode).toBe(0);
      const output = result.output;
      expect(output.agent_id).toBeDefined();
      expect(output.result).toBeDefined();

      testAgentId = String(output.agent_id);
    },
    { timeout: 190000 },
  );

  test(
    "--agent with valid ID uses that agent",
    async () => {
      if (!testAgentId) {
        console.log("Skipping: no test agent available");
        return;
      }

      const result = await runCliJson(
        [
          "--agent",
          testAgentId,
          "-m",
          "sonnet-4.6-low",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        { timeoutMs: 180000 },
      );

      expect(result.exitCode).toBe(0);
      const output = result.output;
      expect(output.agent_id).toBe(testAgentId);
    },
    { timeout: 190000 },
  );

  test(
    "--conversation with valid ID derives agent and uses conversation",
    async () => {
      if (!testAgentId) {
        console.log("Skipping: no test agent available");
        return;
      }

      // First, create a real conversation with --new (since --new-agent uses "default")
      const createResult = await runCliJson(
        [
          "--agent",
          testAgentId,
          "--new",
          "-m",
          "sonnet-4.6-low",
          "-p",
          "Say CREATED",
          "--output-format",
          "json",
        ],
        { timeoutMs: 180000 },
      );
      expect(createResult.exitCode).toBe(0);
      const realConversationId = createResult.output.conversation_id;
      expect(typeof realConversationId).toBe("string");
      if (typeof realConversationId !== "string") {
        throw new Error("Expected a string conversation_id in JSON output");
      }
      expect(realConversationId).toBeDefined();
      expect(realConversationId).not.toBe("default");

      const result = await runCliJson(
        [
          "--conversation",
          realConversationId,
          "-m",
          "sonnet-4.6-low",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        { timeoutMs: 180000 },
      );

      expect(result.exitCode).toBe(0);
      const output = result.output;
      expect(output.agent_id).toBe(testAgentId);
      expect(output.conversation_id).toBe(realConversationId);
    },
    { timeout: 180000 },
  );

  test(
    "--agent + --conversation default succeeds and stays on default route",
    async () => {
      let agentIdForTest = testAgentId;
      if (!agentIdForTest) {
        const bootstrapResult = await runCliJson(
          [
            "--new-agent",
            "-m",
            "sonnet-4.6-low",
            "-p",
            "Say OK",
            "--output-format",
            "json",
          ],
          { timeoutMs: 180000 },
        );
        expect(bootstrapResult.exitCode).toBe(0);
        agentIdForTest = String(bootstrapResult.output.agent_id);
        testAgentId = agentIdForTest;
      }

      const result = await runCliJson(
        [
          "--agent",
          agentIdForTest,
          "--conversation",
          "default",
          "-m",
          "sonnet-4.6-low",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        { timeoutMs: 180000 },
      );

      expect(result.exitCode).toBe(0);
      const output = result.output;
      expect(output.agent_id).toBe(agentIdForTest);
      expect(output.conversation_id).toBe("default");
    },
    { timeout: 190000 },
  );

  test(
    "--new-agent with --init-blocks none creates minimal agent",
    async () => {
      const result = await runCliJson(
        [
          "--new-agent",
          "--init-blocks",
          "none",
          "-m",
          "sonnet-4.6-low",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        { timeoutMs: 180000 },
      );

      expect(result.exitCode).toBe(0);
      const output = result.output;
      expect(output.agent_id).toBeDefined();
    },
    { timeout: 190000 },
  );
});
