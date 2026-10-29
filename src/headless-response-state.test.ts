import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHeadlessResponseState } from "@/headless-response-state";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

// Only the backend is fake. Exercise the real headless entrypoint, stream
// parser, local tools, permissions, and continuation requests in a subprocess.
const fixture = `
import { __testSetBackend } from "./src/backend";
import { setConfiguredBackendMode } from "./src/backend/backend-mode";
import { FakeHeadlessBackend } from "./src/backend/dev/fake-headless-backend";
import { createAssistantMessageStream } from "./src/backend/dev/headless-turn-executor";
import { parseCliArgs } from "./src/cli/args";
import { handleHeadlessCommand } from "./src/headless";
import { settingsManager } from "./src/settings-manager";
await settingsManager.initialize();
// The fake backend reports an OpenAI endpoint type for its fake model, so
// auto toolset detection resolves codex; pin "default" so the fixture's
// Bash/Read tool calls exist regardless of model-based toolset detection.
settingsManager.setToolsetPreference("agent-headless-response-state", "default");
const reviewed = process.env.RESPONSE_STATE_REVIEWED === "1";
const bidirectional = process.env.RESPONSE_STATE_BIDIRECTIONAL === "1";
let turns = 0;
const backend = new FakeHeadlessBackend("agent-headless-response-state", {
  async execute() {
    if (++turns !== 1) return createAssistantMessageStream();
    return { controller: new AbortController(), async *[Symbol.asyncIterator]() {
      yield {
        message_type: "approval_request_message",
        tool_call: {
          tool_call_id: "tool-call-response-state",
          name: reviewed ? "Bash" : "Read",
          arguments: JSON.stringify(reviewed
            ? { command: "echo response-state-tool-ok", description: "Run test command", login: false }
            : { file_path: process.env.RESPONSE_STATE_READ_FILE })
        }
      };
      yield { message_type: "stop_reason", stop_reason: "requires_approval" };
      yield {
        message_type: "response_state",
        cache_scope: "approval_boundary",
        response_id: "response-state-approval"
      };
    } };
  }
});
const createStream = backend.createConversationMessageStream.bind(backend);
backend.createConversationMessageStream = async (conversationId, body, opts) => {
  console.log(JSON.stringify({
    type: "fixture_request", messages: body.messages,
    responseState: opts?.headers?.["X-Letta-Response-State"] ?? null
  }));
  return createStream(conversationId, body);
};
setConfiguredBackendMode("local");
__testSetBackend(backend);
await handleHeadlessCommand(parseCliArgs([
  "bun", "letta", "--agent", "agent-headless-response-state", "--conversation", "default",
  ...(bidirectional ? ["--input-format", "stream-json"] : ["-p", "Read the test file"]),
  "--output-format", "stream-json", "--memfs-startup", "skip", "--no-mods"
], true), undefined, undefined, undefined, false);
`;

interface Event {
  type?: string;
  subtype?: string;
  request_id?: string;
  request?: { subtype?: string };
  responseState?: string | null;
  messages?: Array<{
    type?: string;
    role?: string;
    approvals?: Array<{ status?: string; tool_return?: string }>;
  }>;
}

async function runScenario(options: {
  bidirectional: boolean;
  reviewed?: boolean;
  replaceInput?: boolean;
}): Promise<Event[]> {
  const home = mkdtempSync(join(tmpdir(), "letta-headless-response-state-"));
  mkdirSync(join(home, ".letta"));
  writeFileSync(
    join(home, ".letta", "settings.json"),
    JSON.stringify({ permissions: { alwaysAsk: ["Bash"] } }),
  );
  const readFile = join(home, "input.txt");
  writeFileSync(readFile, "response-state-tool-ok\n");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(
    process.execPath,
    [
      "--loader=.md:text",
      "--loader=.mdx:text",
      "--loader=.txt:text",
      "--eval",
      fixture,
    ],
    {
      cwd: repoRoot,
      env: createIsolatedCliTestEnv({
        HOME: home,
        LETTA_FS_SANDBOX: "0",
        NO_COLOR: "1",
        RESPONSE_STATE_READ_FILE: readFile,
        RESPONSE_STATE_BIDIRECTIONAL: options.bidirectional ? "1" : "0",
        RESPONSE_STATE_REVIEWED: options.reviewed ? "1" : "0",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: Event[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const send = (value: unknown) =>
    child.stdin.write(`${JSON.stringify(value)}\n`);
  const user = (content: string) =>
    send({ type: "user", message: { content } });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      let buffer = "";
      let results = 0;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error) {
          reject(
            new Error(
              `${error.message}; events=${JSON.stringify(events)}; stderr=${stderr}`,
            ),
          );
        } else resolvePromise();
      };
      const timeout = setTimeout(() => finish(new Error("Timed out")), 25_000);
      child.on("error", finish);
      child.on("close", (code) => {
        if (!options.bidirectional && code === 0 && results === 1) finish();
        else finish(new Error(`Fixture exited: ${code}`));
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let event: Event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          events.push(event);
          if (
            options.bidirectional &&
            event.type === "system" &&
            event.subtype === "init"
          ) {
            user("Run the requested local tool");
          }
          if (
            event.type === "control_request" &&
            event.request?.subtype === "can_use_tool"
          ) {
            send({
              type: "control_response",
              response: {
                request_id: event.request_id,
                response: {
                  behavior: "allow",
                  ...(options.replaceInput
                    ? {
                        updatedInput: {
                          command: "echo response-state-replaced-input",
                          description: "Run replacement test command",
                          login: false,
                        },
                      }
                    : {}),
                },
              },
            });
          }
          if (event.type === "result") {
            results++;
            if (options.bidirectional) {
              if (results === 1) user("A separate user turn, without tools");
              else finish();
            }
          }
        }
      });
    });
    return events;
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit();
      else child.once("close", () => resolveExit());
    });
    rmSync(home, { recursive: true, force: true });
  }
}

function requestsWithSuccessfulTool(events: Event[], bidirectional: boolean) {
  expect(
    events.filter((event) => event.type === "result").map((e) => e.subtype),
  ).toEqual(bidirectional ? ["success", "success"] : ["success"]);
  const requests = events.filter((event) => event.type === "fixture_request");
  expect(requests).toHaveLength(bidirectional ? 3 : 2);
  expect(requests[0]?.responseState).toBeNull();
  const approval = requests[1]?.messages?.find((m) => m.type === "approval");
  expect(approval?.approvals?.[0]?.status).toBe("success");
  if (bidirectional) {
    expect(requests[2]?.messages?.some((m) => m.role === "user")).toBe(true);
    expect(requests[2]?.responseState).toBeNull();
  }
  return requests;
}

describe("headless response-state eligibility", () => {
  test("consumes automatic eligibility before a send can fail and retry", () => {
    const state = createHeadlessResponseState();
    const input = state.prepare([], true);
    expect(state.consume(input)).toBe(true);
    expect(state.consume(input)).toBe(false);
  });

  test("replacement or recovery input clears the original batch eligibility", () => {
    const state = createHeadlessResponseState();
    const input = state.prepare([], true);
    expect(state.consume([...input])).toBe(false);
    expect(state.consume(input)).toBe(false);
  });

  test("mixed user and approval input cannot inherit eligibility", () => {
    const state = createHeadlessResponseState();
    const input = state.prepare([], true);
    expect(
      state.consume([
        ...input,
        { role: "user", content: "Recovery instruction" },
      ]),
    ).toBe(false);
    expect(state.consume(input)).toBe(false);
  });

  test("preparing a reviewed batch discards previous automatic eligibility", () => {
    const state = createHeadlessResponseState();
    const automatic = state.prepare([], true);
    const reviewed = state.prepare([], false);
    expect(state.consume(reviewed)).toBe(false);
    expect(state.consume(automatic)).toBe(false);
  });
});

describe("headless approval-boundary response state", () => {
  for (const bidirectional of [false, true]) {
    test(`${bidirectional ? "bidirectional" : "one-shot -p"} automatic tool continuation echoes response state`, async () => {
      const events = await runScenario({ bidirectional });
      const requests = requestsWithSuccessfulTool(events, bidirectional);
      expect(events.some((event) => event.type === "control_request")).toBe(
        false,
      );
      expect(requests[1]?.responseState).toBeString();
      const responseState = JSON.parse(
        Buffer.from(requests[1]?.responseState ?? "", "base64url").toString(),
      );
      expect(responseState).toEqual({
        v: 1,
        cache_scope: "approval_boundary",
        previous_response_id: "response-state-approval",
      });
    }, 30_000);
  }

  for (const replaceInput of [false, true]) {
    test(`callback-reviewed continuation drops response state${replaceInput ? " with replaced input" : ""}`, async () => {
      const events = await runScenario({
        bidirectional: true,
        reviewed: true,
        replaceInput,
      });
      const requests = requestsWithSuccessfulTool(events, true);
      expect(
        events.filter((event) => event.request?.subtype === "can_use_tool"),
      ).toHaveLength(1);
      expect(requests[1]?.responseState).toBeNull();
      expect(JSON.stringify(requests[1]?.messages)).toContain(
        replaceInput
          ? "response-state-replaced-input"
          : "response-state-tool-ok",
      );
    }, 30_000);
  }
});
