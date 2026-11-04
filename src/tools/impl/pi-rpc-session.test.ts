import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  ExternalToolCall,
  ExternalToolResult,
} from "./external-tool-call";
import {
  closePiSessions,
  listPiModels,
  PI_NOT_SIGNED_IN_PREFIX,
  runPiTurn,
  sendPiMessage,
} from "./pi-rpc-session";

/**
 * A fake `pi --mode rpc`: answers the commands this module sends and acts out
 * a scenario chosen by the prompt text. It appends every command it receives
 * to $FAKE_PI_LOG so tests can assert on the wire traffic.
 */
const FAKE_PI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = (record) => fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(record) + "\n");
log({ argv: args, cwd: process.cwd() });
let sessionId = args[args.indexOf("--session-id") + 1];
const sessionFileArg = args.indexOf("--session");
if (sessionFileArg !== -1) sessionId = path.basename(args[sessionFileArg + 1]).replace(/^.*_|\.jsonl$/g, "");
if (args.includes("--session-id")) {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "--fake--");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-01-01T00-00-00-000Z_" + sessionId + ".jsonl"), JSON.stringify({ type: "session", id: sessionId }) + "\n");
}
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const respond = (cmd, data, error) => out({ id: cmd.id, type: "response", command: cmd.type, success: !error, ...(error ? { error } : { data }) });
const assistant = (text, extra = {}) => out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider: "fake", model: "m1", usage: { totalTokens: 7 }, stopReason: "stop", ...extra } });
let running = null;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    log(cmd);
    handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(cmd) {
  if (cmd.type === "get_state") return respond(cmd, { sessionId, isStreaming: Boolean(running) });
  if (cmd.type === "get_available_models") return respond(cmd, { models: [{ id: "m1", name: "Model One", provider: "fake" }, { id: "bad" }] });
  if (cmd.type === "extension_ui_response") return;
  if (cmd.type === "steer") {
    respond(cmd, { disposition: "queued" });
    if (running) { running = null; assistant("steered: " + cmd.message); out({ type: "agent_settled", aborted: false }); }
    return;
  }
  if (cmd.type === "abort") {
    running = null;
    respond(cmd, {});
    out({ type: "agent_settled", aborted: true });
    return;
  }
  if (cmd.type !== "prompt") return respond(cmd, null, "unsupported " + cmd.type);
  const text = cmd.message;
  if (text === "nokey") return respond(cmd, null, "No API key found for the selected model.\n\nUse /login");
  respond(cmd, { disposition: "started" });
  out({ type: "agent_start" });
  if (text === "tool") {
    out({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } });
    out({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] }, isError: false });
    out({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "pondering" } });
    out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Ran it" } });
    assistant("Ran it done");
    out({ type: "agent_settled", aborted: false });
  } else if (text === "error") {
    out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." } });
    out({ type: "agent_settled", aborted: false });
  } else if (text === "dialog") {
    out({ type: "extension_ui_request", id: "ui-1", method: "notify", message: "fyi" });
    out({ type: "extension_ui_request", id: "ui-2", method: "confirm", title: "Allow rm?" });
  } else if (text === "crash") {
    process.exit(3);
  } else if (text === "slow") {
    running = { cmd };
  } else {
    assistant("echo: " + text);
    out({ type: "agent_settled", aborted: false });
  }
}
`;

const SESSION = "0190f5c2-6c1e-7b3a-9f4e-1a2b3c4d5e6f";
let dir: string;
let env: NodeJS.ProcessEnv;
let logPath: string;

function wire(): Array<Record<string, unknown>> {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "letta-fake-pi-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), FAKE_PI);
  chmodSync(join(bin, "pi"), 0o755);
  logPath = join(dir, "wire.log");
  env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    FAKE_PI_LOG: logPath,
  };
});

afterEach(async () => {
  await closePiSessions();
  rmSync(logPath, { force: true });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function turn(
  prompt: string,
  extra: Partial<Parameters<typeof runPiTurn>[0]> = {},
) {
  return runPiTurn(
    { prompt, parentAgentId: "agent-parent", cwd: dir, ...extra },
    env,
  );
}

describe("runPiTurn", () => {
  test("streams progress and reports the final assistant text", async () => {
    const calls: ExternalToolCall[] = [];
    const results: ExternalToolResult[] = [];
    const texts: string[] = [];
    const reasoning: string[] = [];
    const started: string[] = [];
    const beforeStart: string[] = [];
    const result = await turn("tool", {
      model: "fake/m1",
      mcpReminder: "<reminder>",
      onToolCall: (call) => calls.push(call),
      onToolResult: (result) => results.push(result),
      onText: (text) => texts.push(text),
      onReasoning: (text) => reasoning.push(text),
      onStarted: (id) => started.push(id),
      beforeStart: async (id) => {
        beforeStart.push(id);
      },
    });
    expect(result).toMatchObject({
      success: true,
      // A U+2028 inside a JSON string must not split the record.
      report: "Ran it done",
      model: "fake/m1",
      totalTokens: 7,
    });
    expect(result.runtimeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.agentId).toBe(`pi_${result.runtimeSessionId}`);
    expect(started).toEqual([result.runtimeSessionId as string]);
    expect(beforeStart).toEqual(started);
    expect(calls).toEqual([
      {
        id: "call-1",
        name: "bash",
        args: '{"command":"echo hi"}',
        input: { command: "echo hi" },
      },
    ]);
    expect(results).toEqual([
      { id: "call-1", name: "bash", isError: false, output: "hi\n" },
    ]);
    expect(texts).toEqual(["Ran it"]);
    expect(reasoning).toEqual(["pondering"]);
    const argv = wire()[0]?.argv as string[];
    expect(argv).toEqual([
      "--mode",
      "rpc",
      "--session-id",
      result.runtimeSessionId as string,
      "--model",
      "fake/m1",
      "--append-system-prompt",
      "<reminder>",
    ]);
  });

  test("a provider error after retries fails the turn with pi's message", async () => {
    expect(await turn("error")).toMatchObject({
      success: false,
      error: "Connection error.",
    });
  });

  test("a rejected prompt without credentials is classified as not signed in", async () => {
    const result = await turn("nokey");
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(
      `${PI_NOT_SIGNED_IN_PREFIX} No API key found`,
    );
  });

  test("a blocking extension dialog is cancelled and fails the turn", async () => {
    const result = await turn("dialog");
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain(
      "pi requires interactive input (confirm: Allow rm?)",
    );
    expect(wire()).toContainEqual({
      type: "extension_ui_response",
      id: "ui-2",
      cancelled: true,
    });
    expect(wire()).not.toContainEqual(
      expect.objectContaining({ type: "extension_ui_response", id: "ui-1" }),
    );
  });

  test("an unexpected exit fails the active turn", async () => {
    const result = await turn("crash");
    expect(result.success).toBe(false);
    expect(result.error).toContain("pi exited unexpectedly (code 3)");
  });

  test("aborting the signal sends abort and stops the turn", async () => {
    const controller = new AbortController();
    const pending = turn("slow", {
      signal: controller.signal,
      onStarted: () => controller.abort(),
    });
    const result = await pending;
    expect(result).toMatchObject({ success: false });
    expect(wire().some((record) => record.type === "abort")).toBe(true);
  });

  test("a missing executable reports the standard prefix", async () => {
    const result = await runPiTurn(
      { prompt: "hi", parentAgentId: "agent-parent", cwd: dir },
      { ...env, PATH: join(dir, "empty") },
    );
    expect(result.error).toStartWith("Required executable 'pi' was not found");
  });
});

describe("sendPiMessage", () => {
  test("steers an active turn and resumes an idle session by file", async () => {
    let sessionId = "";
    const first = turn("slow", {
      onStarted: (id) => {
        sessionId = id;
      },
    });
    for (let i = 0; i < 200 && !sessionId; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await sendPiMessage(
        {
          sessionId,
          prompt: "go left",
          parentAgentId: "agent-parent",
          cwd: dir,
        },
        env,
      ),
    ).toEqual({ mode: "steered" });
    expect(await first).toMatchObject({
      success: true,
      report: "steered: go left",
    });

    // A fresh process reopens the session from its file.
    await closePiSessions();
    const followup = await sendPiMessage(
      { sessionId, prompt: "again", parentAgentId: "agent-parent", cwd: dir },
      env,
    );
    expect(followup.mode).toBe("new_turn");
    expect(await followup.completion).toMatchObject({
      success: true,
      report: "echo: again",
      runtimeSessionId: sessionId,
    });
    const resumeArgv = wire()
      .filter((record) => Array.isArray(record.argv))
      .at(-1)?.argv as string[];
    expect(resumeArgv.slice(0, 3)).toEqual(["--mode", "rpc", "--session"]);
    expect(resumeArgv[3]).toEndWith(`_${sessionId}.jsonl`);
  });

  test("resuming an unknown session fails instead of starting a new one", async () => {
    await expect(
      sendPiMessage(
        {
          sessionId: SESSION,
          prompt: "hi",
          parentAgentId: "agent-parent",
          cwd: dir,
        },
        env,
      ),
    ).rejects.toThrow(`pi session ${SESSION} was not found`);
  });
});

describe("listPiModels", () => {
  test("returns provider-qualified IDs and skips malformed entries", async () => {
    expect(await listPiModels(dir, env)).toEqual([
      { id: "fake/m1", displayName: "Model One" },
    ]);
  });
});
