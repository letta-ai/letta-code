import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BROWSER_DISCOVERY_HOST,
  type BrowserDiscoveryServerHandle,
  startBrowserDiscoveryServer,
} from "./browser-discovery-server";

const handles: BrowserDiscoveryServerHandle[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(blockers.splice(0).map(closeServer));
});

describe("browser discovery server", () => {
  test("returns a minimal cross-origin status response", async () => {
    const { address } = await startServer();
    const response = await fetch(address.url, {
      headers: { Origin: "https://chat.letta.com" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("answers browser private-network preflight requests", async () => {
    const { address } = await startServer();
    const response = await fetch(address.url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://chat.letta.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
  });

  test("rejects other paths, methods, and host headers", async () => {
    const { address } = await startServer();
    const baseUrl = `http://${address.host}:${address.port}`;

    expect((await fetch(`${baseUrl}/other`)).status).toBe(404);
    const methodResponse = await fetch(address.url, { method: "POST" });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, OPTIONS");
    expect(
      (
        await fetch(address.url, {
          headers: { Host: `localhost:${address.port}` },
        })
      ).status,
    ).toBe(400);
  });

  test("takes over the fixed port after another owner exits", async () => {
    const blocker = createServer((_request, response) => {
      response.writeHead(503).end();
    });
    blockers.push(blocker);
    await listen(blocker, 0);
    const port = (blocker.address() as AddressInfo).port;

    const handle = startBrowserDiscoveryServer({ port, retryDelayMs: 10 });
    handles.push(handle);
    let ready = false;
    void handle.ready.then(() => {
      ready = true;
    });
    await Bun.sleep(30);
    expect(ready).toBe(false);

    await closeServer(blocker);
    blockers.splice(blockers.indexOf(blocker), 1);
    const address = await handle.ready;

    expect(address.port).toBe(port);
    expect(await (await fetch(address.url)).json()).toEqual({ status: "ok" });
  });

  test("closing a contender cancels port takeover", async () => {
    const blocker = createServer((_request, response) => {
      response.writeHead(503).end();
    });
    blockers.push(blocker);
    await listen(blocker, 0);
    const port = (blocker.address() as AddressInfo).port;

    const handle = startBrowserDiscoveryServer({ port, retryDelayMs: 10 });
    handles.push(handle);
    const readyResult = handle.ready.catch((error: Error) => error.message);
    await handle.close();
    handles.splice(handles.indexOf(handle), 1);
    expect(await readyResult).toBe(
      "Browser discovery server stopped before listening",
    );

    await closeServer(blocker);
    blockers.splice(blockers.indexOf(blocker), 1);
    await Bun.sleep(30);
    const replacement = createServer();
    blockers.push(replacement);
    await listen(replacement, port);
    expect((replacement.address() as AddressInfo).port).toBe(port);
  });
});

async function startServer(): Promise<{
  handle: BrowserDiscoveryServerHandle;
  address: Awaited<BrowserDiscoveryServerHandle["ready"]>;
}> {
  const handle = startBrowserDiscoveryServer({ port: 0 });
  handles.push(handle);
  return { handle, address: await handle.ready };
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, BROWSER_DISCOVERY_HOST, resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
