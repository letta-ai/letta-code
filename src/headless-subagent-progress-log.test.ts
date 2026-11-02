// End-to-end: a Letta subagent's tool calls, tool results, reasoning and
// assistant messages reach the background task's output file (one readable
// line each) and its JSONL event log (in full) while the subagent is still
// running, so a parent can check on it.
//
// The harness runs the real CLI headless against an in-process mock
// OpenAI-compatible provider that forces one Agent tool call. The subagent
// child binary is overridden (LETTA_CODE_BIN) with a script that streams
// stream-json progress, then holds its result until the test has read the
// output file mid-run.
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

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

const TIMESTAMP = String.raw`\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]`;

describe("headless Letta subagent progress log", () => {
  test("writes tool calls, results and assistant messages to the task logs while the subagent runs", async () => {
    const run = await runScenario();
    const detail = `exit=${run.code}\nreceipt:\n${run.receipt}\nmid-run:\n${run.midRun}\nevents:\n${run.midRunEvents}\nfinal:\n${run.taskOutput}\nstderr:\n${run.stderrTail}`;

    expect(run.code, detail).toBe(0);
    // The receipt and the output file's header both name the event log.
    expect(run.eventsFile, detail).toBe(
      run.outputFile?.replace(/\.log$/, ".jsonl"),
    );
    expect(run.taskOutput, detail).toContain(`[event log: ${run.eventsFile} `);
    // Read while the child was holding its result: progress is already there.
    expect(run.midRun, detail).not.toContain("[Task completed]");
    expect(run.midRun, detail).toMatch(
      new RegExp(
        `${TIMESTAMP} session: agent agent-mock-child, conversation conv-mock-child\\n` +
          `${TIMESTAMP} text: I'll check the repo layout first\\.\\n` +
          `${TIMESTAMP} tool: Bash \\{"command":"ls -la","description":"List files"\\}\\n` +
          `${TIMESTAMP} result: Bash ok, 6 B\\n` +
          `${TIMESTAMP} text: Found the files; now waiting on the slow step\\.\\n` +
          `${TIMESTAMP} tool: Bash \\{"command":"sleep 600"\\}\\n$`,
      ),
    );
    // Reasoning and full tool output stay out of the readable log, and the
    // streamed chunks of one message become one `text:` line.
    expect(run.midRun, detail).not.toContain("thinking about it");
    expect(run.midRun, detail).not.toContain("file-a");

    // The event log has every event, in order and in full.
    const events = run.midRunEvents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      events.map(({ at, ...rest }) => {
        expect(typeof at, detail).toBe("string");
        return rest;
      }),
      detail,
    ).toEqual([
      {
        seq: 1,
        type: "session",
        agent_id: "agent-mock-child",
        conversation_id: "conv-mock-child",
      },
      { seq: 2, type: "reasoning", text: "thinking about it" },
      { seq: 3, type: "text", text: "I'll check the repo layout first." },
      {
        seq: 4,
        type: "tool_call",
        id: "call-1",
        name: "Bash",
        input: { command: "ls -la", description: "List files" },
      },
      {
        seq: 5,
        type: "tool_result",
        tool_call_id: "call-1",
        name: "Bash",
        is_error: false,
        output: "file-a",
      },
      {
        seq: 6,
        type: "text",
        text: "Found the files; now waiting on the slow step.",
      },
      {
        seq: 7,
        type: "tool_call",
        id: "call-2",
        name: "Bash",
        input: { command: "sleep 600" },
      },
    ]);

    // The final message lands as progress before the result block.
    const progressEnd = run.taskOutput.indexOf("text: All done.");
    const resultStart = run.taskOutput.indexOf("subagent_type=general-purpose");
    expect(progressEnd, detail).toBeGreaterThan(-1);
    expect(resultStart, detail).toBeGreaterThan(progressEnd);
    expect(run.taskOutput, detail).toContain(
      "SUBAGENT-REPORT-OK\n\n[Task completed]\n",
    );
    expect(run.taskOutput.match(/tool: Bash/g), detail).toHaveLength(2);
  }, 90_000);
});

async function runScenario(): Promise<{
  code: number | null;
  receipt: string;
  outputFile: string | undefined;
  eventsFile: string | undefined;
  midRun: string;
  midRunEvents: string;
  taskOutput: string;
  stderrTail: string;
}> {
  // Canonicalize: on macOS tmpdir() is a symlink, and a cwd/USER_CWD mismatch
  // makes project settings load under one path and resolve under another.
  const tmpRoot = realpathSync(
    await mkdtemp(join(tmpdir(), "letta-subagent-progress-")),
  );
  tempRoots.push(tmpRoot);
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const localBackendDir = join(tmpRoot, "local-backend");
  const releaseFile = join(tmpRoot, "release");
  for (const dir of [homeDir, projectDir, localBackendDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const childScript = join(tmpRoot, "mock-subagent-child.ts");
  writeFileSync(childScript, buildMockChildScript());

  const provider = startMockProvider(releaseFile);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(
    process.execPath,
    [
      "--loader=.md:text",
      "--loader=.mdx:text",
      "--loader=.txt:text",
      "run",
      join(repoRoot, "src", "index.ts"),
      "--backend",
      "local",
      "--yolo",
      "--memfs-startup",
      "skip",
      "--output-format",
      "text",
      "-p",
      "spawn a subagent and keep tabs on it",
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
        CHILD_RELEASE_FILE: releaseFile,
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

  let stderr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 80_000);
  const code = await new Promise<number | null>((resolvePromise) => {
    child.on("exit", (exitCode) => {
      clearTimeout(timeout);
      cliProcesses.delete(child);
      resolvePromise(exitCode);
    });
  });
  provider.server.stop(true);
  // Release the child in case the provider never did, so it can exit.
  writeFileSync(releaseFile, "1");

  const taskOutput = provider.outputFile
    ? readFileSync(provider.outputFile, "utf-8")
    : "";
  return {
    code,
    receipt: provider.receipt,
    outputFile: provider.outputFile,
    eventsFile: provider.eventsFile,
    midRun: provider.midRun,
    midRunEvents: provider.midRunEvents,
    taskOutput,
    stderrTail: stderr.slice(-4_000),
  };
}

/**
 * Stands in for the subagent CLI: streams progress in the shape the headless
 * CLI emits (assistant text in chunks sharing one ID, reasoning, tool calls
 * and returns, usage), then waits for the release file before its last
 * message and result.
 */
function buildMockChildScript(): string {
  return `
import { existsSync } from "node:fs";

await new Response(Bun.stdin.stream()).text().catch(() => "");

function write(event) {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(event) + "\\n", () => resolve());
  });
}
function chunk(id, content) {
  return { type: "message", message_type: "assistant_message", id, content };
}
function toolCall(id, args) {
  return {
    type: "message",
    message_type: "tool_call_message",
    date: new Date().toISOString(),
    tool_call: { tool_call_id: id, name: "Bash", arguments: JSON.stringify(args) },
  };
}

await write({
  type: "system",
  subtype: "init",
  agent_id: "agent-mock-child",
  conversation_id: "conv-mock-child",
});
await write({ type: "message", message_type: "reasoning_message", id: "m1", reasoning: "thinking about it" });
await write(chunk("m1", "I'll check"));
await write(chunk("m1", " the repo layout"));
await write(chunk("m1", " first."));
await write({ type: "message", message_type: "stop_reason", stop_reason: "requires_approval" });
await write({ type: "message", message_type: "usage_statistics", total_tokens: 5 });
await write(toolCall("call-1", { command: "ls -la", description: "List files" }));
await write({ type: "message", message_type: "tool_return_message", tool_call_id: "call-1", status: "success", tool_return: "file-a" });
await write(chunk("m2", "Found the files; now waiting on the slow step."));
await write(toolCall("call-2", { command: "sleep 600" }));

const release = process.env.CHILD_RELEASE_FILE;
while (!existsSync(release)) await Bun.sleep(20);

await write({ type: "message", message_type: "tool_return_message", tool_call_id: "call-2", status: "success", tool_return: "" });
await write(chunk("m3", "All done."));
await write({
  type: "result",
  subtype: "success",
  result: "SUBAGENT-REPORT-OK",
  is_error: false,
  duration_ms: 5,
  num_turns: 2,
  usage: { total_tokens: 10, step_count: 2 },
});
process.exit(0);
`;
}

/**
 * Minimal OpenAI-compatible SSE provider. Round 1 forces one Agent tool call.
 * Round 2 (the CLI reporting the launch) reads the task output file once the
 * child has logged its slow tool call, records that mid-run snapshot,
 * releases the child, and waits for the report before ending the turn.
 */
function startMockProvider(releaseFile: string): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  outputFile: string | undefined;
  eventsFile: string | undefined;
  receipt: string;
  midRun: string;
  midRunEvents: string;
} {
  const state = {
    outputFile: undefined as string | undefined,
    eventsFile: undefined as string | undefined,
    receipt: "",
    midRunEvents: "",
    midRun: "",
  };
  let chatRequests = 0;

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
        if (message.role !== "tool") continue;
        // Read the receipt as plain text: JSON-encoding it would double the
        // backslashes of a Windows path.
        const text = messageText(message.content);
        if (!text.includes("Output file:")) continue;
        state.receipt = text;
        state.outputFile ??= text.match(/Output file: ([^\r\n]+)/)?.[1]?.trim();
        state.eventsFile ??= text.match(/Event log: ([^\r\n]+)/)?.[1]?.trim();
      }

      if (round === 2 && state.outputFile) {
        state.midRun = await waitForContent(state.outputFile, "sleep 600");
        if (state.eventsFile)
          state.midRunEvents = await waitForContent(
            state.eventsFile,
            "sleep 600",
          );
        writeFileSync(releaseFile, "1");
        await waitForContent(state.outputFile, "[Task completed]");
      }

      const base = {
        id: `chatcmpl-${round}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4",
      };
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
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
                usage,
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
                usage,
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

  return {
    server,
    port: server.port ?? 0,
    get outputFile() {
      return state.outputFile;
    },
    get eventsFile() {
      return state.eventsFile;
    },
    get receipt() {
      return state.receipt;
    },
    get midRunEvents() {
      return state.midRunEvents;
    },
    get midRun() {
      return state.midRun;
    },
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

async function waitForContent(path: string, needle: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  let content = "";
  while (Date.now() < deadline) {
    content =
      existsSync(path) && statSync(path).isFile()
        ? readFileSync(path, "utf-8")
        : "";
    if (content.includes(needle)) return content;
    await Bun.sleep(20);
  }
  return content;
}
