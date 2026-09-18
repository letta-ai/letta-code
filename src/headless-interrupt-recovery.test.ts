import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

// Run the real bidirectional entrypoint in isolation: only the model/backend is
// fake. Monitor, its socket, stdin control requests, and queue recovery are real.
const fixture = `
import { __testSetBackend } from "./src/backend";
import { setConfiguredBackendMode } from "./src/backend/backend-mode";
import { FakeHeadlessBackend } from "./src/backend/dev/fake-headless-backend";
import { createAssistantMessageStream } from "./src/backend/dev/headless-turn-executor";
import { parseCliArgs } from "./src/cli/args";
import { handleHeadlessCommand } from "./src/headless";
import { monitor } from "./src/tools/impl/monitor";
import { settingsManager } from "./src/settings-manager";
await settingsManager.initialize();
let turns = 0;
const backend = new FakeHeadlessBackend("agent-headless-interrupt", {
  async execute(input) {
    turns++;
    console.log(JSON.stringify({ type: "fixture_input", turn: turns, body: { messages: input.body.messages } }));
    if (turns === 1) {
      await monitor({ description: "Watch headless interrupt events", persistent: true,
        ws: { url: process.env.MONITOR_TEST_URL },
        parentScope: { agentId: input.agentId, conversationId: input.conversationId } });
    }
    if (turns !== 2) return createAssistantMessageStream();
    const controller = new AbortController();
    return { controller, async *[Symbol.asyncIterator]() {
      console.log(JSON.stringify({ type: "fixture_waiting" }));
      if (!controller.signal.aborted) {
        await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }));
      }
    } };
  }
});
setConfiguredBackendMode("local");
__testSetBackend(backend);
await handleHeadlessCommand(parseCliArgs([
  "bun", "letta", "--agent", "agent-headless-interrupt", "--conversation", "default",
  "--input-format", "stream-json", "--output-format", "stream-json",
  "--memfs-startup", "skip", "--no-mods"
], true), undefined, undefined, undefined, false);
`;

test("headless interrupt stops a real Monitor, preserves its queued event, and sends recovery on the next turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "letta-headless-monitor-interrupt-"));
  let onHandshake!: (accept: (verified: boolean) => void) => void;
  const handshakeRequested = new Promise<(verified: boolean) => void>(
    (resolve) => {
      onHandshake = resolve;
    },
  );
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (_info, done) => {
      // Hold the handshake until the first turn is idle. This forces the
      // ordering that used to let the test send before a socket existed.
      onHandshake(done);
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing socket address");
  let socket: WebSocket;
  let closed = false;
  const connected = new Promise<void>((resolve) => {
    server.once("connection", (client) => {
      socket = client;
      client.once("close", () => {
        closed = true;
      });
      resolve();
    });
  });
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
        MONITOR_TEST_URL: `ws://127.0.0.1:${address.port}`,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: Array<Record<string, unknown>> = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const send = (value: unknown) =>
    child.stdin.write(`${JSON.stringify(value)}\n`);
  const user = (content: string) =>
    send({ type: "user", message: { content } });
  const interrupt = (requestId: string) =>
    send({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" },
    });
  let survivedCompletion = false;
  let survivedIdleInterrupt = false;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      let buffer = "";
      let results = 0;
      let waiting = false;
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
          if (event.type === "system" && event.subtype === "init")
            user("complete normally");
          if (event.type === "result") {
            results++;
            if (results === 1) {
              // Unlike interrupt, initialize is handled by the main loop,
              // after the turn's finally block has finished.
              send({
                type: "control_request",
                request_id: "after-first-turn",
                request: { subtype: "initialize" },
              });
            } else if (results === 3) finish();
          }
          if (
            event.type === "control_response" &&
            (event.response as { request_id?: string })?.request_id ===
              "after-first-turn"
          ) {
            void (async () => {
              const accept = await handshakeRequested;
              accept(true);
              await connected;
              survivedCompletion = socket.readyState === 1 && !closed;
              interrupt("idle-interrupt");
            })().catch(finish);
          }
          if (
            event.type === "control_response" &&
            (event.response as { request_id?: string })?.request_id ===
              "idle-interrupt"
          ) {
            survivedIdleInterrupt = socket.readyState === 1 && !closed;
            user("wait until interrupted");
          }
          if (event.type === "fixture_waiting") {
            waiting = true;
            socket.send("queued real Monitor event before interrupt");
          }
          if (waiting && !interrupted && event.type === "queue_blocked") {
            interrupted = true;
            interrupt("active-interrupt");
          }
        }
      });
    });
    expect(survivedCompletion).toBe(true);
    expect(survivedIdleInterrupt).toBe(true);
    const deadline = Date.now() + 2000;
    while (!closed && Date.now() < deadline) await Bun.sleep(10);
    expect(closed).toBe(true);
    expect(
      events
        .filter((event) => event.type === "result")
        .map((event) => event.subtype),
    ).toEqual(["success", "interrupted", "success"]);
    const nextTurn = events.find(
      (event) => event.type === "fixture_input" && event.turn === 3,
    );
    const body = JSON.stringify(nextTurn?.body);
    expect(body).toContain("queued real Monitor event before interrupt");
    expect(body).toContain(
      "Any pending monitors in this conversation were also cancelled",
    );
    expect(body).toContain("Do not restart them unless the user asks.");
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    for (const client of server.clients) client.terminate();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
