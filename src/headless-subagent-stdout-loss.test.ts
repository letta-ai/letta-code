// End-to-end regression test for #3257: a subagent child whose stdout stream
// is lost before the final result envelope must be retried once by the parent
// with the original spawn arguments, instead of surfacing a truncated-output
// parse failure.
//
// The harness runs the real CLI headless against an in-process mock
// OpenAI-compatible provider that forces one Agent tool call. The subagent
// child binary is overridden (LETTA_CODE_BIN) with a script that simulates
// the failure on its first spawn and succeeds on the second, so the whole
// spawn → detect-loss → retry → collect-result path is exercised for real.
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";
import { SUBAGENT_STDOUT_LOST_MARKER } from "@/utils/subagent-stdout-failure";

type ChildFailMode = "truncate-result" | "stderr-marker";

interface ScenarioSummary {
  code: number | null;
  spawnArgvs: string[][];
  toolResults: string;
  stdoutTail: string;
  stderrTail: string;
}

const cliProcesses = new Set<ChildProcessWithoutNullStreams>();
const tempRoots: string[] = [];

afterAll(async () => {
  for (const child of cliProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("headless subagent stdout loss", () => {
  test("retries once and recovers the report when the child's stream is truncated mid-result", async () => {
    const summary = await runStdoutLossScenario("truncate-result");

    expect(summary.code, formatSummary(summary)).toBe(0);
    // Exactly one retry: the isRetry guard must prevent further respawns.
    expect(summary.spawnArgvs, formatSummary(summary)).toHaveLength(2);
    // The retry must preserve the original spawn arguments verbatim.
    expect(summary.spawnArgvs[1]).toEqual(summary.spawnArgvs[0]);
    // The recovered report reaches the model as a successful tool result.
    expect(summary.toolResults, formatSummary(summary)).toContain(
      "SUBAGENT-REPORT-OK",
    );
    expect(summary.toolResults, formatSummary(summary)).not.toContain(
      "Failed to parse subagent output",
    );
  }, 90_000);

  test("retries once and recovers the report when the child exits 1 with the stdout-lost marker", async () => {
    const summary = await runStdoutLossScenario("stderr-marker");

    expect(summary.code, formatSummary(summary)).toBe(0);
    expect(summary.spawnArgvs, formatSummary(summary)).toHaveLength(2);
    expect(summary.spawnArgvs[1]).toEqual(summary.spawnArgvs[0]);
    expect(summary.toolResults, formatSummary(summary)).toContain(
      "SUBAGENT-REPORT-OK",
    );
  }, 90_000);
});

async function runStdoutLossScenario(
  mode: ChildFailMode,
): Promise<ScenarioSummary> {
  // Canonicalize the temp root: on macOS tmpdir() is a symlink
  // (/var/folders -> /private/var/folders), and the spawned CLI's
  // process.cwd() resolves to the real path while USER_CWD would carry the
  // symlink path — the mismatch makes local project settings load under one
  // path and get looked up under the other, crashing startup.
  const tmpRoot = realpathSync(
    await mkdtemp(join(tmpdir(), "letta-subagent-stdout-loss-")),
  );
  tempRoots.push(tmpRoot);
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const localBackendDir = join(tmpRoot, "local-backend");
  const childStateDir = join(tmpRoot, "child-state");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(localBackendDir, { recursive: true });
  mkdirSync(childStateDir, { recursive: true });

  const childScript = join(tmpRoot, "mock-subagent-child.ts");
  writeFileSync(childScript, buildMockChildScript());

  const provider = startMockProvider();

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliEntry = join(repoRoot, "src", "index.ts");
  const child = spawn(
    process.execPath,
    [
      "--loader=.md:text",
      "--loader=.mdx:text",
      "--loader=.txt:text",
      "run",
      cliEntry,
      "--backend",
      "local",
      "--yolo",
      "--memfs-startup",
      "skip",
      "--output-format",
      "text",
      "-p",
      "spawn a subagent to produce the test report",
    ],
    {
      cwd: projectDir,
      env: createIsolatedCliTestEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        LETTA_LOCAL_BACKEND_DIR: localBackendDir,
        LMSTUDIO_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
        LETTA_CODE_BIN: process.execPath,
        LETTA_CODE_BIN_ARGS_JSON: JSON.stringify(["run", childScript]),
        CHILD_STATE_DIR: childStateDir,
        CHILD_FAIL_MODE: mode,
        LETTA_FS_SANDBOX: "0",
        USER_CWD: projectDir,
        NO_COLOR: "1",
        DO_NOT_TRACK: "1",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  cliProcesses.add(child);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 80_000);

  const code = await new Promise<number | null>((resolvePromise) => {
    child.on("exit", (exitCode) => {
      clearTimeout(timeout);
      cliProcesses.delete(child);
      resolvePromise(exitCode);
    });
  });

  provider.server.stop(true);

  return {
    code,
    spawnArgvs: readSpawnArgvs(childStateDir),
    toolResults: provider.toolResults.join("\n"),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

/**
 * The script standing in for the spawned subagent CLI (via LETTA_CODE_BIN).
 * First spawn simulates #3257 according to CHILD_FAIL_MODE:
 *   - truncate-result: emits the result envelope cut mid-JSON and exits 0
 *     (the child believed it succeeded; the parent sees a truncated stream).
 *   - stderr-marker: exits 1 with the stdout-lost marker on stderr (the
 *     child detected the loss, as src/utils/headless-stdout-guard.ts does).
 * Later spawns emit a complete result envelope. Every spawn records its argv
 * so the test can assert the retry preserved the original arguments.
 */
function buildMockChildScript(): string {
  return `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.CHILD_STATE_DIR ?? "";
const failMode = process.env.CHILD_FAIL_MODE ?? "truncate-result";

// Drain the prompt the parent writes to stdin.
await new Response(Bun.stdin.stream()).text().catch(() => "");

appendFileSync(
  join(stateDir, "spawns.jsonl"),
  \`\${JSON.stringify(process.argv.slice(2))}\\n\`,
);

const initLine = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "mock-child-session",
  agent_id: "agent-mock-child",
  conversation_id: "conv-mock-child",
});
const resultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "SUBAGENT-REPORT-OK",
  is_error: false,
  duration_ms: 5,
  num_turns: 1,
  usage: { total_tokens: 10, step_count: 1 },
});

function writeAll(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

const firstSpawnMarker = join(stateDir, "first-spawn.marker");
if (!existsSync(firstSpawnMarker)) {
  writeFileSync(firstSpawnMarker, "1\\n");
  if (failMode === "stderr-marker") {
    console.error(${JSON.stringify(`${SUBAGENT_STDOUT_LOST_MARKER} (test-injected)`)});
    process.exit(1);
  }
  // Truncate the result envelope mid-JSON, no trailing newline.
  await writeAll(\`\${initLine}\\n\${resultLine.slice(0, resultLine.length - 25)}\`);
  process.exit(0);
}

await writeAll(\`\${initLine}\\n\${resultLine}\\n\`);
process.exit(0);
`;
}

/**
 * Minimal OpenAI-compatible SSE provider: the first chat round forces one
 * Agent tool call, later rounds record the tool results the CLI sends back
 * and finish the turn.
 */
function startMockProvider(): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  toolResults: string[];
} {
  let chatRequests = 0;
  const toolResults: string[] = [];

  const server = Bun.serve({
    port: 0,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "gpt-4", object: "model" }],
        });
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      chatRequests += 1;
      const round = chatRequests;
      const body = (await req.json()) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const agentToolName = (body.tools ?? [])
        .map((t) => t.function?.name)
        .find((name) => name === "Agent" || name === "Task");
      for (const message of body.messages ?? []) {
        if (message.role === "tool") {
          toolResults.push(JSON.stringify(message.content));
        }
      }

      const base = {
        id: `chatcmpl-${round}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4",
      };
      const chunks =
        round === 1 && agentToolName
          ? [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_subagent_1",
                          type: "function",
                          function: {
                            name: agentToolName,
                            arguments: JSON.stringify({
                              description: "run test subagent",
                              prompt: "produce the test report",
                              subagent_type: "general-purpose",
                              run_in_background: false,
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              },
            ]
          : [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "provider-done" },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              },
            ];

      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          controller.enqueue("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
  });

  return { server, port: server.port ?? 0, toolResults };
}

function readSpawnArgvs(childStateDir: string): string[][] {
  try {
    return readFileSync(join(childStateDir, "spawns.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

function tail(text: string): string {
  return text.split("\n").slice(-40).join("\n");
}

function formatSummary(summary: ScenarioSummary): string {
  return JSON.stringify(summary, null, 2);
}
