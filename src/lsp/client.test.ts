import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { LSPClient } from "@/lsp/client";

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

test("pending request is rejected when the server process exits without responding", async () => {
  // Server: read and discard stdin, then exit immediately on the first message.
  const server = spawnScript(`
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk.toString();
      // Once we've received anything, exit without responding.
      if (buf.includes("Content-Length:")) {
        // Exit on next tick so the client's write flushes.
        setImmediate(() => process.exit(0));
      }
    });
  `);

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

  server.kill();
});

test("request sent after the server exited rejects immediately", async () => {
  // Server that exits right away.
  const server = spawnScript(`setImmediate(() => process.exit(0));`);

  const client = new LSPClient({
    serverID: "test",
    server: { process: server },
    rootUri: process.cwd(),
  });

  // Wait for the exit handler to mark the client as disposed.
  await new Promise<void>((resolve) => {
    client.on("exit", () => resolve());
  });

  const pending = (
    client as unknown as {
      sendRequest<T>(method: string, params?: unknown): Promise<T>;
    }
  ).sendRequest("anything", {});

  // New requests against a dead server must fail fast rather than enqueue a
  // promise that can never be settled.
  await expect(pending).rejects.toThrow(/LSP server has exited/);
});

test("responded request resolves; only a later, unrelated exit rejects others", async () => {
  // Server: respond to the first message, then exit on the second.
  const server = spawnScript(`
    let buf = "";
    let handled = false;
    process.stdin.on("data", (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/Content-Length: (\\d+)/);
      if (match && !handled) {
        const body = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';
        process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n' + body);
        handled = true;
        buf = "";
      } else if (match && handled) {
        setImmediate(() => process.exit(1));
      }
    });
  `);

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

  server.kill();
});
