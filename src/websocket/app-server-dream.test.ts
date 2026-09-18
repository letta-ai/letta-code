import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

// Exercise the shipping entrypoints, not a second command handler. All outbound
// fetches are blocked except api.letta.com requests rewritten to our HTTP server.
// Run the built path after `bun run build` with LETTA_TEST_BUILT_ARTIFACT=1.
const runtimes: ("bun" | "node")[] =
  process.env.LETTA_TEST_BUILT_ARTIFACT === "1" ? ["bun", "node"] : ["bun"];

function commandResponse(
  socket: WebSocket,
  id: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Command response timed out"));
    }, 15_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw));
      if (
        message.type !== "execute_command_response" ||
        message.request_id !== id
      )
        return;
      cleanup();
      resolveResponse(message);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

describe.each(runtimes)("/dream over real %s app-server", (runtime) => {
  test("WS → scoped SDK POST → HTTP receipt/error; no model or message requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "letta-dream-test-"));
    const requests: {
      path: string;
      method: string;
      body: unknown;
      authorization: string | null;
      actor: string | null;
    }[] = [];
    let cutover = true;
    let configStatus = 200;
    let status = 202;
    let responseBody: unknown = { status: "queued", run_id: "run-fixture" };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({
          path,
          method: request.method,
          body: request.method === "GET" ? null : await request.json(),
          authorization: request.headers.get("authorization"),
          actor: request.headers.get("X-Letta-Acting-User-Id"),
        });
        if (request.method === "GET")
          return Response.json({ cutover }, { status: configStatus });
        return Response.json(responseBody, { status });
      },
    });
    const preload = join(dir, "fetch-fixture.mjs");
    await writeFile(
      preload,
      `
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol === "data:") return realFetch(request);
  if (url.origin !== "https://api.letta.com") throw new Error("Blocked external fetch: " + url.origin);
  return realFetch(new Request(${JSON.stringify(server.url.origin)} + url.pathname + url.search, request));
};
`,
    );
    const root = resolve(import.meta.dir, "../..");
    const child = spawn(
      runtime,
      [
        runtime === "bun" ? "--preload" : "--import",
        preload,
        runtime === "bun" ? "src/index.ts" : "letta.js",
        "server",
        "--listen",
        "ws://127.0.0.1:0",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          LETTA_HOME: join(dir, ".letta"),
          LETTA_API_KEY: "fixture-scoped-key",
          LETTA_BASE_URL: "https://api.letta.com",
          LETTA_DISABLE_MODS: "1",
          LETTA_DISABLE_CRON_SCHEDULER: "1",
          LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0",
          LETTA_DESKTOP_CREDENTIALS_IPC: "0",
          LETTA_DEBUG: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let socket: WebSocket | undefined;
    let logs = "";
    child.stderr.on("data", (chunk) => {
      logs += String(chunk);
    });
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`App-server startup timed out: ${logs}`)),
          30_000,
        );
        child.stdout.on("data", (chunk) => {
          logs += String(chunk);
          const match = logs.match(/WebSocket: (ws:\/\/[^\s]+)/);
          if (match?.[1]) {
            clearTimeout(timer);
            resolveUrl(match[1]);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`App-server exited ${code}: ${logs}`));
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      socket = new WebSocket(url);
      await once(socket, "open");
      // This ID correlates WebSocket responses only, not backend admission.
      const id = "dream-transport-request";
      const frame = {
        type: "execute_command",
        command_id: "dream",
        request_id: id,
        runtime: {
          agent_id: "agent-fixture",
          conversation_id: "conv-fixture",
          acting_user_id: "user-fixture",
        },
      };
      const send = async (args?: string) => {
        const pending = commandResponse(socket as WebSocket, id);
        socket?.send(JSON.stringify({ ...frame, args }));
        return pending;
      };
      expect(await send()).toMatchObject({
        request_id: id,
        success: true,
        output: "Dreaming...",
      });
      status = 409;
      responseBody = {
        code: "busy",
        message: "The conversation already has active reflection work",
      };
      expect(await send()).toMatchObject({
        request_id: id,
        success: false,
        output: expect.stringContaining("HTTP 409, busy"),
      });
      status = 200;
      responseBody = { status: "no_work" };
      expect(await send()).toMatchObject({
        success: true,
        output: "No new work to reflect on in this conversation.",
      });
      status = 409;
      responseBody = {
        detail: {
          reason: "source_not_finished",
          message: "Finish the source conversation first.",
        },
      };
      expect(await send()).toMatchObject({
        success: false,
        output: expect.stringContaining("source_not_finished"),
      });
      status = 503;
      responseBody = { detail: { reason: "admission_paused" } };
      expect(await send()).toMatchObject({
        success: false,
        output: expect.stringContaining("admission_paused"),
      });
      status = 404;
      responseBody = { detail: "Not Found" };
      expect(await send()).toMatchObject({
        success: false,
        output: expect.stringContaining("unavailable on this server"),
      });
      expect(await send("--instruction never run this")).toMatchObject({
        success: false,
        output: expect.stringContaining("does not accept arguments"),
      });
      configStatus = 403;
      expect(await send()).toMatchObject({ success: false });
      configStatus = 200;
      cutover = false;
      for (const alias of ["dream", "reflect", "reflection"]) {
        frame.command_id = alias;
        expect(await send("--recent 2")).toMatchObject({
          success: false,
          output: expect.stringContaining("Use the TUI"),
        });
        expect(await send('--instruction "remember this"')).toMatchObject({
          success: true,
          output: expect.stringContaining("memory filesystem"),
        });
      }
      cutover = true;
      status = 202;
      responseBody = { status: "queued", run_id: "alias-fixture" };
      for (const alias of ["reflect", "reflection"]) {
        frame.command_id = alias;
        expect(await send()).toMatchObject({
          success: true,
          output: "Dreaming...",
        });
      }
      const posts = requests.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(8);
      for (const request of requests.filter(
        (request) => request.method === "GET",
      )) {
        expect(request.path).toBe("/v1/agents/agent-fixture/reflection");
        expect(request.actor).toBe("user-fixture");
        expect(request.authorization).toBe("Bearer fixture-scoped-key");
      }
      for (const request of posts) {
        expect(request).toEqual({
          path: "/v1/agents/agent-fixture/reflection/runs",
          method: "POST",
          body: { conversation_id: "conv-fixture" },
          authorization: "Bearer fixture-scoped-key",
          actor: "user-fixture",
        });
      }
    } finally {
      socket?.terminate();
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
