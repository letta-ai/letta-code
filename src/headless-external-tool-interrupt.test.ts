/**
 * End-to-end coverage for cancelling a turn while an SDK external tool is
 * in flight (headless bidirectional mode). The real entrypoint runs in an
 * isolated child process with a fake backend; stdin control requests and the
 * external-tool wire protocol are real.
 *
 * Regression (PR: abort in-flight tool operations, seam 2):
 *  - Before: an interrupt during the external-tool wait mislabeled the tool
 *    result as "stdin closed" and silently dropped any user line queued
 *    while the tool ran.
 *  - After: the tool result is interruption-shaped ("Interrupted by user"),
 *    and queued lines are deferred back to the main loop and processed
 *    after the cancelled turn unwinds.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

// Run the real bidirectional entrypoint in isolation: only the model/backend
// is fake. External tool registration, the execute_external_tool wire
// request, permissions, interrupts, and queue recovery are real.
const fixture = `
import { __testSetBackend } from "./src/backend";
import { setConfiguredBackendMode } from "./src/backend/backend-mode";
import { FakeHeadlessBackend } from "./src/backend/dev/fake-headless-backend";
import { createAssistantMessageStream } from "./src/backend/dev/headless-turn-executor";
import { parseCliArgs } from "./src/cli/args";
import { handleHeadlessCommand } from "./src/headless";
import { settingsManager } from "./src/settings-manager";
await settingsManager.initialize();
let turns = 0;
const backend = new FakeHeadlessBackend("agent-headless-ext-interrupt", {
  async execute(input) {
    turns++;
    console.log(JSON.stringify({ type: "fixture_input", turn: turns, body: { messages: input.body.messages } }));
    if (turns === 1) {
      const chunks = [
        {
          message_type: "approval_request_message",
          tool_call: {
            tool_call_id: "ext-call-1",
            name: "ext_hang_test",
            arguments: JSON.stringify({ payload: "hang" }),
          },
        },
        { message_type: "stop_reason", stop_reason: "requires_approval" },
      ];
      const controller = new AbortController();
      return { controller, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
    }
    return createAssistantMessageStream();
  }
});
setConfiguredBackendMode("local");
__testSetBackend(backend);
await handleHeadlessCommand(parseCliArgs([
  "bun", "letta", "--agent", "agent-headless-ext-interrupt", "--conversation", "default",
  "--input-format", "stream-json", "--output-format", "stream-json",
  "--memfs-startup", "skip", "--no-mods"
], true), undefined, undefined, undefined, false);
`;

test("interrupt during an in-flight external tool returns an interruption-shaped result and preserves queued input", async () => {
  const home = mkdtempSync(join(tmpdir(), "letta-headless-ext-interrupt-"));
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
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: Array<Record<string, unknown>> = [];
  const results: string[] = [];
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
      let registered = false;
      let sentUser = false;
      let externalRequested = false;
      let queuedWhileWaiting = false;
      let interrupted = false;
      const timeout = setTimeout(() => finish(new Error("Timed out")), 25_000);
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error)
          reject(
            new Error(
              `${error.message}; events=${JSON.stringify(events)}; stderr=${stderr}`,
            ),
          );
        else resolvePromise();
      };
      child.on("error", finish);
      child.on("close", (code) => finish(new Error(`Fixture exited: ${code}`)));
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          events.push(event);

          if (event.type === "system" && event.subtype === "init") {
            // Register the external tool before the first turn.
            send({
              type: "control_request",
              request_id: "reg-ext-1",
              request: {
                subtype: "register_external_tools",
                tools: [
                  {
                    name: "ext_hang_test",
                    description: "Test tool that hangs until interrupted",
                    parameters: {
                      type: "object",
                      properties: { payload: { type: "string" } },
                    },
                  },
                ],
              },
            });
            registered = true;
          }
          if (
            registered &&
            !sentUser &&
            event.type === "control_response" &&
            (event.response as { request_id?: string })?.request_id ===
              "reg-ext-1"
          ) {
            sentUser = true;
            user("run the hanging external tool");
          }
          if (
            event.type === "control_request" &&
            (event.request as { subtype?: string })?.subtype === "can_use_tool"
          ) {
            // Approve the external tool call.
            send({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: (event as { request_id?: string }).request_id ?? "",
                response: { behavior: "allow" },
              },
            });
          }
          if (
            event.type === "control_request" &&
            (event.request as { subtype?: string })?.subtype ===
              "execute_external_tool"
          ) {
            // The SDK client deliberately never responds: the tool hangs.
            externalRequested = true;
          }
          if (externalRequested && !queuedWhileWaiting) {
            // A user line queued while the external tool is in flight must be
            // preserved (deferred), not silently dropped.
            queuedWhileWaiting = true;
            user("queued during external wait");
          }
          if (queuedWhileWaiting && !interrupted) {
            interrupted = true;
            send({
              type: "control_request",
              request_id: "int-1",
              request: { subtype: "interrupt" },
            });
          }
          if (event.type === "result") {
            results.push(String(event.subtype));
            if (results.length >= 2) finish();
          }
        }
      });
    });
    // The cancelled turn's tool result must be interruption-shaped, not the
    // old "stdin closed" mislabel.
    const toolReturn = events.find(
      (event) =>
        event.message_type === "tool_return_message" &&
        event.tool_call_id === "ext-call-1",
    );
    expect(toolReturn).toBeDefined();
    expect(String(toolReturn?.tool_return)).toMatch(/interrupted by user/i);
    expect(String(toolReturn?.tool_return)).not.toContain("stdin closed");
    // The turn unwinds as interrupted and the queued line still runs.
    expect(results).toEqual(["interrupted", "success"]);
    const queuedTurn = events.find(
      (event) =>
        event.type === "fixture_input" &&
        JSON.stringify(event.body).includes("queued during external wait"),
    );
    expect(queuedTurn).toBeDefined();
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
