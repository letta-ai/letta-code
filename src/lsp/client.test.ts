import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { LSPClient } from "@/lsp/client";
import type { LSPServerProcess } from "@/lsp/types";

/**
 * Spawn a minimal "LSP server" process: it reads JSON-RPC messages from stdin
 * (so the client's Content-Length framing works) but its behavior is controlled
 * by the script. We use this instead of a mock so the real ChildProcess wiring
 * and exit handling in LSPClient are exercised.
 */
function spawnScript(script: string) {
  return spawn("bun", ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function withScriptServer(
  script: string,
  run: (
    server: ReturnType<typeof spawnScript>,
    signal: AbortSignal,
  ) => Promise<void>,
  timeoutMs = 3000,
) {
  const server = spawnScript(script);
  const abort = new AbortController();
  const closed = new Promise<void>((resolve) =>
    server.once("close", () => resolve()),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onError: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    onError = reject;
    server.once("error", onError);
    timer = setTimeout(
      () => reject(new Error("server test timed out")),
      timeoutMs,
    );
  });
  // Start through a promise so synchronous exceptions also go through cleanup.
  const work = Promise.resolve().then(() => run(server, abort.signal));
  try {
    await Promise.race([work, failure]);
  } finally {
    clearTimeout(timer);
    abort.abort();
    server.kill("SIGKILL");
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([closed, work]),
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(
            () => reject(new Error("server cleanup timed out")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
      server.removeListener("error", onError);
    }
  }
}

test("server fixture cleans up after a timeout and waits for callback cleanup", async () => {
  let callbackFinished = false;
  let closed = false;
  await expect(
    withScriptServer(
      `process.stdin.resume();`,
      async (server, signal) => {
        server.once("close", () => {
          closed = true;
        });
        try {
          await once(signal, "abort");
          throw new Error("late callback failure");
        } finally {
          await new Promise((resolve) => setTimeout(resolve, 20));
          callbackFinished = true;
        }
      },
      100,
    ),
  ).rejects.toThrow("server test timed out");
  expect(closed).toBe(true);
  expect(callbackFinished).toBe(true);
}, 5000);

function mockServer() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: () => true,
  });
  const client = new LSPClient({
    serverID: "test",
    server: { process } as unknown as LSPServerProcess,
    rootUri: "/tmp",
  });
  const request = (
    client as unknown as {
      sendRequest<T>(method: string): Promise<T>;
    }
  ).sendRequest.bind(client);
  return { process, client, request };
}

test("stdout errors reject pending and future requests before notifying listeners", async () => {
  const { process, client, request } = mockServer();
  const first = request("first");
  const second = request("second");
  client.on("error", () => {
    throw new Error("listener failed");
  });
  expect(() =>
    process.stdout.emit("error", new Error("broken stdout")),
  ).toThrow("listener failed");
  const bounded = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("request timed out")), 200),
      ),
    ]);
  await expect(bounded(first)).rejects.toThrow("broken stdout");
  await expect(bounded(second)).rejects.toThrow("broken stdout");
  await expect(bounded(request("later"))).rejects.toThrow("broken stdout");
});

test("stdout error clears pending requests without an error listener", async () => {
  const { process, request } = mockServer();
  const pending = request("first");
  expect(() =>
    process.stdout.emit("error", new Error("broken stdout")),
  ).toThrow();
  await expect(pending).rejects.toThrow("broken stdout");
  await expect(request("later")).rejects.toThrow("broken stdout");
});

test("shutdown kills the server when its request fails", async () => {
  const { process, client } = mockServer();
  let killed = false;
  process.kill = () => {
    killed = true;
    return true;
  };
  (client as unknown as { initialized: boolean }).initialized = true;
  const shutdown = client.shutdown();
  process.emit("exit", 1);
  process.emit("close", 1);
  await expect(shutdown).rejects.toThrow("LSP server exited");
  expect(killed).toBe(true);
});

test("exit blocks new requests but allows the final buffered response before close", async () => {
  const { process, request } = mockServer();
  const pending = request<{ ok: boolean }>("first");
  process.emit("exit", 0);
  await expect(request("later")).rejects.toThrow("exited");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  process.stdout.emit(
    "data",
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`),
  );
  process.emit("close", 0);
  expect(await pending).toEqual({ ok: true });
});

test("pending request is rejected when the server process exits without responding", async () => {
  // Server: read and discard stdin, then exit immediately on the first message.
  await withScriptServer(
    `
    process.stdin.once("data", () => {
      setImmediate(() => process.exit(0));
    });
  `,
    async (server) => {
      const client = new LSPClient({
        serverID: "test",
        server: { process: server },
        rootUri: process.cwd(),
      });

      // sendRequest is private, so reach it through the public surface. A bogus
      // method is fine — what matters is that a request is pending when the
      // process dies, and that it rejects instead of hanging forever.
      const pending = (
        client as unknown as {
          sendRequest<T>(method: string, params?: unknown): Promise<T>;
        }
      ).sendRequest("some/pendingMethod", {});

      // Before the fix, this promise would hang because the exit handler did not
      // reject outstanding requests.
      await expect(pending).rejects.toThrow(/LSP server exited/);
    },
  );
}, 5000);

test("request sent after the server exited rejects immediately", async () => {
  // Server that exits right away.
  await withScriptServer(
    `setImmediate(() => process.exit(0));`,
    async (server, signal) => {
      const client = new LSPClient({
        serverID: "test",
        server: { process: server },
        rootUri: process.cwd(),
      });

      // Wait for the exit handler to mark the client as disposed.
      await once(client, "exit", { signal });

      const pending = (
        client as unknown as {
          sendRequest<T>(method: string, params?: unknown): Promise<T>;
        }
      ).sendRequest("anything", {});

      // New requests against a dead server must fail fast rather than enqueue a
      // promise that can never be settled.
      await expect(pending).rejects.toThrow(/LSP server exited/);
    },
  );
}, 5000);

// Server: respond to the first complete frame, then exit on the second.
const framedServerScript = `
    let buf = Buffer.alloc(0);
    let handled = false;
    process.stdin.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const end = buf.indexOf("\\r\\n\\r\\n");
        if (end < 0) break;
        const match = buf.subarray(0, end).toString("ascii").match(/Content-Length: (\\d+)/i);
        if (!match) throw new Error("missing Content-Length");
        const frameEnd = end + 4 + Number(match[1]);
        if (buf.length < frameEnd) break;
        buf = buf.subarray(frameEnd);
        if (!handled) {
          const body = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';
          process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
          handled = true;
        } else {
          setImmediate(() => process.exit(1));
        }
      }
    });
  `;

test("server fixture handles split headers and bodies followed by coalesced frames", async () => {
  await withScriptServer(framedServerScript, async (server, signal) => {
    const chunks: Buffer[] = [];
    server.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const close = once(server, "close", { signal });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "first" });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const bodyStart = frame.indexOf("\r\n\r\n") + 4;
    server.stdin.write(frame.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chunks).toHaveLength(0);
    server.stdin.write(frame.slice(10, bodyStart + 2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chunks).toHaveLength(0);
    server.stdin.write(frame.slice(bodyStart + 2) + frame);
    const [code] = await close;
    expect(code).toBe(1);
    const response = Buffer.concat(chunks).toString();
    expect(response).toContain('"result":{"ok":true}');
    expect(response.match(/Content-Length:/g)).toHaveLength(1);
  });
}, 5000);

test("responded request resolves; only a later, unrelated exit rejects others", async () => {
  await withScriptServer(framedServerScript, async (server) => {
    const client = new LSPClient({
      serverID: "test",
      server: { process: server },
      rootUri: process.cwd(),
    });

    const sendRequest = (
      client as unknown as {
        sendRequest<T>(method: string, params?: unknown): Promise<T>;
      }
    ).sendRequest.bind(client);

    const first = sendRequest<{ ok: boolean }>("first");
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);

    // Second request will still be pending when the server exits.
    const second = sendRequest("second");
    await expect(second).rejects.toThrow(/LSP server exited/);
  });
}, 5000);
