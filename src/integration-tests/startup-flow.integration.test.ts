import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClient } from "@/backend/api/client";
import {
  type EnqueueReceipt,
  getExactSuperRun,
  listEnqueuedRunMessages,
} from "@/backend/api/conversation-enqueue";
import { resolveEnvironmentConnectionId } from "@/backend/api/environments";
import { createEphemeralConversation } from "@/backend/api/ephemeral-conversations";
import { apiRequest } from "@/backend/api/request";
import { waitForAcceptedSuperRun } from "@/headless-super-run-wait";
import { settingsManager } from "@/settings-manager";
import {
  createAuthenticatedCliTestEnv,
  createIsolatedCliTestEnv,
} from "@/test-utils/test-process-env";
import {
  formatAttemptDiagnostics,
  formatCapturedOutput,
} from "./process-diagnostics";

/**
 * Startup flow integration tests.
 *
 * These spawn the real CLI and require LETTA_API_KEY to be set.
 * They are executed in CI only for push to main / trusted PRs (non-forks).
 */

const projectRoot = process.cwd();
const cliCommand = process.env.LETTA_TEST_CLI_BUNDLE ? "node" : "bun";
const cliArgs = process.env.LETTA_TEST_CLI_BUNDLE
  ? [process.env.LETTA_TEST_CLI_BUNDLE]
  : ["run", "dev"];

async function runCli(
  args: string[],
  options: {
    timeoutMs?: number;
    expectExit?: number;
    retryOnTimeouts?: number;
    env?: NodeJS.ProcessEnv;
    includeMemfsStartup?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const {
    timeoutMs = 30000,
    expectExit,
    retryOnTimeouts = 1,
    env = createAuthenticatedCliTestEnv(),
    includeMemfsStartup = true,
  } = options;
  const failedAttempts: Array<{ attempt: number; message: string }> = [];

  const runOnce = () =>
    new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolve, reject) => {
        const proc = spawn(
          cliCommand,
          [
            ...cliArgs,
            ...(includeMemfsStartup ? ["--memfs-startup", "skip"] : []),
            ...args,
          ],
          {
            cwd: projectRoot,
            env,
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
  options: Parameters<typeof runCli>[1] & {
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
          "conv-00000000-0000-0000-0000-000000000000",
          "-p",
          "test",
        ],
        { expectExit: 1, timeoutMs: 60000 },
      );
      expect(result.stderr).toContain("not found");
    },
    { timeout: 70000 },
  );
});

// ============================================================================
// Integration Tests (require API access, create real agents)
// ============================================================================

describe("Startup Flow - Integration", () => {
  let testAgentId: string | null = null;
  let testConversationId: string | null = null;

  test(
    "--ephemeral uses saved Cloud authentication without creating an agent",
    async () => {
      const apiKey = process.env.LETTA_API_KEY;
      if (!apiKey) {
        throw new Error("LETTA_API_KEY is required for this integration test");
      }

      const homeDir = await mkdtemp(
        join(tmpdir(), "letta-ephemeral-cloud-home-"),
      );
      const settingsDir = join(homeDir, ".letta");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          env: { LETTA_API_KEY: apiKey },
          preferredBackendMode: "api",
        }),
      );

      try {
        const result = await runCliJson(
          [
            "--ephemeral",
            "-m",
            "openai/gpt-5.6-luna",
            "-p",
            "Reply with EPHEMERAL_CLOUD_OK and nothing else",
            "--tools=",
            "--output-format",
            "json",
          ],
          {
            timeoutMs: 180000,
            includeMemfsStartup: false,
            env: createIsolatedCliTestEnv({
              HOME: homeDir,
              LETTA_SKIP_KEYCHAIN_CHECK: "1",
            }),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.output.agent_id).toBeNull();
        expect(result.output.conversation_id).toStartWith("conv-");
        expect(result.output.result).toBeDefined();
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    },
    { timeout: 190000 },
  );

  test.each(["standalone", "listener"])(
    "--conversation resumes the same worker history: %s",
    async (mode) => {
      await settingsManager.initialize();
      const homeDir = await mkdtemp(join(tmpdir(), "letta-listener-resume-"));
      const name = `resume-test-${crypto.randomUUID()}`;
      const env = createAuthenticatedCliTestEnv({
        HOME: homeDir,
        LETTA_DEBUG: "0",
        DEBUG: undefined,
        LETTA_SKIP_KEYCHAIN_CHECK: "1",
        LETTA_LISTENER_DEVICE_ID: undefined,
        LETTA_LISTENER_INSTANCE_ID: undefined,
        LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID: undefined,
        LETTA_RUNTIME_LISTENER_CONNECTION_ID: undefined,
      });
      const listener =
        mode === "listener"
          ? spawn(
              cliCommand,
              [
                ...cliArgs,
                "server",
                "--computer-name",
                name,
                "--lifecycle-output",
                "jsonl",
              ],
              { env },
            )
          : undefined;
      let listenerOutput = "";
      listener?.stderr.on("data", (chunk) => {
        listenerOutput += chunk;
      });
      let parentId: string | undefined;
      let conversationId: string | undefined;
      try {
        let connectionId: string | undefined;
        if (listener) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(`Listener startup timed out: ${listenerOutput}`),
                ),
              60000,
            );
            listener.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            listener.once("exit", (code) => {
              clearTimeout(timer);
              reject(new Error(`Listener exited ${code}: ${listenerOutput}`));
            });
            listener.stdout.on("data", (chunk) => {
              listenerOutput += chunk;
              if (listenerOutput.includes('"state":"connected"')) {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          ({ connectionId } = await resolveEnvironmentConnectionId(name));
          const parent = await apiRequest<{ id: string }>(
            "POST",
            "/v1/agents/",
            {
              name,
              model: "openai/gpt-5.6-luna",
              system: "Test parent agent.",
              memory_blocks: [],
              include_base_tools: false,
              hidden: true,
            },
          );
          parentId = parent.id;
        }
        const conversation = await createEphemeralConversation({
          model: "openai/gpt-5.6-luna",
          system: "Always prefix your reply with WORKER-PROMPT.",
          ...(parentId ? { parent_agent_id: parentId } : {}),
          is_subagent: true,
          name,
        });
        conversationId = conversation.id;
        const runTurn = (prompt: string, connection?: string) =>
          runCliJson(
            [
              "--conversation",
              conversation.id,
              "-p",
              prompt,
              "--tools=",
              "--output-format",
              "json",
            ],
            {
              timeoutMs: 180000,
              expectExit: 0,
              includeMemfsStartup: false,
              retryOnTimeouts: 0,
              retryOnParseErrors: 0,
              env: {
                ...env,
                LETTA_CODE_AGENT_ROLE: "subagent",
                LETTA_SUBAGENT_LAUNCH: "1",
                LETTA_RUNTIME_LISTENER_CONNECTION_ID: connection,
              },
            },
          );
        await runTurn("Remember the codeword MINT-8932. Reply only OK.");
        const resumed = await runTurn(
          "What codeword did I ask you to remember? Reply only the codeword.",
          connectionId,
        );
        expect(resumed.output).toMatchObject({
          agent_id: null,
          conversation_id: conversationId,
        });
        const client = await getClient();
        expect(
          await client.conversations.retrieve(conversationId),
        ).toMatchObject({
          agent_id: null,
          parent_agent_id: parentId ?? null,
        });
        let reply = resumed.output.result;
        if (connectionId) {
          expect(resumed.output).toMatchObject({
            status: "queued",
            parent_agent_id: parentId,
            connection_id: connectionId,
          });
          reply = (
            await waitForAcceptedSuperRun(
              resumed.output as unknown as EnqueueReceipt,
              AbortSignal.timeout(180000),
              {
                exact: getExactSuperRun,
                run: (id, signal) => client.runs.retrieve(id, { signal }),
                messages: listEnqueuedRunMessages,
              },
            )
          ).text;
        }
        expect(String(reply)).toContain("MINT-8932");
        expect(String(reply)).toStartWith("WORKER-PROMPT");
      } finally {
        listener?.kill();
        if (
          listener &&
          listener.exitCode === null &&
          listener.signalCode === null
        ) {
          await new Promise<void>((resolve) =>
            listener.once("exit", () => resolve()),
          );
        }
        if (conversationId)
          await apiRequest("DELETE", `/v1/conversations/${conversationId}`);
        if (parentId) await apiRequest("DELETE", `/v1/agents/${parentId}`);
        await rm(homeDir, { recursive: true, force: true });
      }
    },
    { timeout: 420000 },
  );

  test(
    "--ephemeral runs fully locally without Cloud authentication or persistent state",
    async () => {
      const homeDir = await mkdtemp(
        join(tmpdir(), "letta-ephemeral-local-home-"),
      );
      const storageDir = await mkdtemp(
        join(tmpdir(), "letta-ephemeral-local-store-"),
      );

      try {
        const result = await runCliJson(
          [
            "--backend",
            "local",
            "--ephemeral",
            "-m",
            "openai/gpt-5.6-luna",
            "-p",
            "Reply with EPHEMERAL_LOCAL_OK and nothing else",
            "--tools=",
            "--output-format",
            "json",
          ],
          {
            timeoutMs: 60000,
            includeMemfsStartup: false,
            env: createIsolatedCliTestEnv({
              HOME: homeDir,
              LETTA_LOCAL_BACKEND_DIR: storageDir,
              LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
              LETTA_SKIP_KEYCHAIN_CHECK: "1",
            }),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(result.output.agent_id).toBeNull();
        expect(result.output.conversation_id).toStartWith("local-conv-");
        expect(result.output.result).toBeDefined();
        expect(existsSync(join(storageDir, "agents"))).toBe(false);
        expect(existsSync(join(storageDir, "conversations"))).toBe(false);
        expect(existsSync(join(storageDir, "memfs"))).toBe(false);
      } finally {
        await Promise.all([
          rm(homeDir, { recursive: true, force: true }),
          rm(storageDir, { recursive: true, force: true }),
        ]);
      }
    },
    { timeout: 70000 },
  );

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
    "--new creates a non-default conversation for the selected agent",
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
      testConversationId = realConversationId;
    },
    { timeout: 370000 },
  );

  test(
    "--conversation resolves the agent and submits to the selected conversation",
    async () => {
      if (!testAgentId || !testConversationId) {
        console.log("Skipping: no test conversation available");
        return;
      }

      const result = await runCliJson(
        [
          "--conversation",
          testConversationId,
          // The process that created the conversation has exited, so verify
          // destination resolution and Cloud acceptance without waiting for a receiver.
          "--no-wait",
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        {
          timeoutMs: 60000,
          retryOnTimeouts: 0,
          retryOnParseErrors: 0,
        },
      );

      expect(result.exitCode).toBe(0);
      const output = result.output;
      expect(output.status).toBe("queued");
      expect(output.agent_id).toBe(testAgentId);
      expect(output.conversation_id).toBe(testConversationId);
    },
    { timeout: 70000 },
  );

  test(
    "--agent + --conversation default submits to the default route",
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
          // The process that created the agent has exited, so verify default
          // route resolution and Cloud acceptance without waiting for a receiver.
          "--no-wait",
          // Keep the model set during agent creation.
          "-p",
          "Say OK",
          "--output-format",
          "json",
        ],
        {
          timeoutMs: 60000,
          retryOnTimeouts: 0,
          retryOnParseErrors: 0,
        },
      );

      expect(result.exitCode).toBe(0);
      const output = result.output;
      expect(output.status).toBe("queued");
      expect(output.agent_id).toBe(agentIdForTest);
      expect(output.conversation_id).toBe("default");
    },
    { timeout: 70000 },
  );
});
