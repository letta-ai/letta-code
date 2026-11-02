import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

// Real headless entrypoint and bidirectional SDK transport. Only model/backend
// responses are deterministic; the harness actually receives and answers the
// nested execute_external_tool request over stdin/stdout.
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
const backend = new FakeHeadlessBackend("agent-code-mode-harness", {
  async execute() {
    if (++turns !== 1) return createAssistantMessageStream();
    const chunks = [
      { message_type: "approval_request_message", tool_call: {
        tool_call_id: "code-mode-call", name: "CodeMode",
        arguments: JSON.stringify({code: "return await tools.fetch_thread({thread: '123'});"})
      } },
      { message_type: "stop_reason", stop_reason: "requires_approval" }
    ];
    return {controller: new AbortController(), async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }};
  }
});
setConfiguredBackendMode("local");
__testSetBackend(backend);
await handleHeadlessCommand(parseCliArgs([
  "bun", "letta", "--agent", "agent-code-mode-harness", "--conversation", "default",
  "--input-format", "stream-json", "--output-format", "stream-json",
  "--permission-mode", "unrestricted", "--memfs-startup", "skip", "--no-mods"
], true), undefined, undefined, undefined, false);
`;

test("one headless CodeMode call invokes a harness-provided tool over the SDK transport", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-code-mode-"));
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
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      env: createIsolatedCliTestEnv({
        HOME: home,
        LETTA_FS_SANDBOX: "0",
        NO_COLOR: "1",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: Record<string, unknown>[] = [];
  const requests: unknown[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const send = (message: unknown) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => finish(new Error("Timed out")), 20000);
      let finished = false;
      function finish(error?: Error) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error)
          reject(
            new Error(
              `${error.message}; events=${JSON.stringify(events)}; stderr=${stderr}`,
            ),
          );
        else resolve();
      }
      child.on("error", finish);
      child.on("close", (code) => finish(new Error(`Exited: ${code}`)));
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
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
            send({
              type: "control_request",
              request_id: "register",
              request: {
                subtype: "register_external_tools",
                tools: [
                  {
                    name: "fetch_thread",
                    description: "Fetch a thread",
                    parameters: { type: "object" },
                  },
                ],
              },
            });
          }
          if (
            event.type === "control_response" &&
            (event.response as { request_id?: string })?.request_id ===
              "register"
          ) {
            send({
              type: "user",
              message: { content: "Fetch thread 123 using CodeMode" },
            });
          }
          const request = event.request as
            | {
                subtype?: string;
                tool_name?: string;
                tool_call_id?: string;
                input?: unknown;
              }
            | undefined;
          if (
            event.type === "control_request" &&
            request?.subtype === "can_use_tool"
          ) {
            send({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: event.request_id,
                response: { behavior: "allow" },
              },
            });
          }
          if (
            event.type === "control_request" &&
            request?.subtype === "execute_external_tool"
          ) {
            requests.push({ name: request.tool_name, input: request.input });
            send({
              type: "control_response",
              response: {
                subtype: "external_tool_result",
                tool_call_id: request.tool_call_id,
                content: [{ type: "text", text: "thread from harness" }],
                is_error: false,
              },
            });
          }
          if (event.type === "result") finish();
        }
      });
    });
    expect(requests).toEqual([
      { name: "fetch_thread", input: { thread: "123" } },
    ]);
    const returned = events.find(
      (event) =>
        event.message_type === "tool_return_message" &&
        event.tool_call_id === "code-mode-call",
    );
    expect(returned).toBeDefined();
    expect(JSON.parse(String(returned?.tool_return))).toEqual({
      result: "thread from harness",
      output: [],
    });
  } finally {
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    rmSync(home, { recursive: true, force: true });
  }
}, 25000);
