import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createConnection } from "node:net";
import { join, relative } from "node:path";
import type { BrowserDeviceMcpOAuthRequest } from "./browser-device-mcp-oauth";
import {
  BROWSER_DEVICE_MCP_OAUTH_PATH,
  BROWSER_DISCOVERY_HOST,
  type BrowserDiscoveryServerHandle,
  startBrowserDiscoveryServer,
} from "./browser-discovery-server";

const handles: BrowserDiscoveryServerHandle[] = [];
const blockers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(blockers.splice(0).map(closeServer));
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser discovery server", () => {
  test("returns a minimal cross-origin status response", async () => {
    const { address } = await startServer();
    const response = await fetch(address.url, {
      headers: { Origin: "https://chat.letta.com" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://chat.letta.com",
    );
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
      "GET, POST, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://chat.letta.com",
    );
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

  test("starts MCP OAuth from an allowed browser origin", async () => {
    const requests: BrowserDeviceMcpOAuthRequest[] = [];
    const { address } = await startServer(async (request) => {
      requests.push(request);
    });
    const response = await fetch(
      `http://${address.host}:${address.port}${BROWSER_DEVICE_MCP_OAUTH_PATH}`,
      {
        body: JSON.stringify({
          agentId: "agent-123",
          service: "datadog",
          serverUrl: "https://mcp.datadoghq.com/v1/mcp",
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://chat.letta.com",
          "X-Letta-Local-Connect": "1",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "connected" });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://chat.letta.com",
    );
    expect(requests).toEqual([
      {
        agentId: "agent-123",
        service: "datadog",
        serverUrl: "https://mcp.datadoghq.com/v1/mcp",
      },
    ]);
  });

  test("rejects untrusted origins and malformed command bodies", async () => {
    const { address } = await startServer(async () => undefined);
    const url = `http://${address.host}:${address.port}${BROWSER_DEVICE_MCP_OAUTH_PATH}`;
    const untrusted = await fetch(url, {
      body: JSON.stringify({
        agentId: "agent-123",
        service: "datadog",
        serverUrl: "https://mcp.datadoghq.com/v1/mcp",
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
        "X-Letta-Local-Connect": "1",
      },
      method: "POST",
    });
    expect(untrusted.status).toBe(403);
    expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();

    const malformed = await fetch(url, {
      body: JSON.stringify({ agentId: "agent-123" }),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://chat.letta.com",
        "X-Letta-Local-Connect": "1",
      },
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ status: "invalid_request" });
  });

  test("answers command private-network preflight with narrow CORS", async () => {
    const { address } = await startServer(async () => undefined);
    const response = await fetch(
      `http://${address.host}:${address.port}${BROWSER_DEVICE_MCP_OAUTH_PATH}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://chat.letta.com",
          "Access-Control-Request-Headers":
            "content-type,x-letta-local-connect",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://chat.letta.com",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, X-Letta-Local-Connect",
    );
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
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

    const address = await withTimeout(
      (async () => {
        await closeServer(blocker);
        blockers.splice(blockers.indexOf(blocker), 1);
        return await handle.ready;
      })(),
      2_000,
      "Timed out waiting for browser discovery port takeover",
    );

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

  test("accepted sockets do not keep the published Node runtime alive", async () => {
    const fixture = await buildNodeFixture(`
const handle = startBrowserDiscoveryServer({ port: 0 });
const address = await handle.ready;
console.log(JSON.stringify(address));
setTimeout(() => undefined, 500);
`);
    const child = spawn("node", [fixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const address = JSON.parse(
      await readFirstLine(child, () => stderr),
    ) as Awaited<BrowserDiscoveryServerHandle["ready"]>;
    const socket = createConnection(address.port, address.host);
    socket.on("error", () => undefined);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `GET /status HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\n`,
      );
      const exit = await waitForChildExit(child, 2_000, () => stderr);
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      socket.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  test("early close does not leave an unhandled ready rejection in Node", async () => {
    const fixture = await buildNodeFixture(`
const handle = startBrowserDiscoveryServer({ port: 0 });
await handle.close();
console.log("closed");
`);
    const result = spawnSync("node", [fixture], {
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("closed");
    expect(result.stderr).toBe("");
  });
});

async function startServer(): Promise<{
  handle: BrowserDiscoveryServerHandle;
  address: Awaited<BrowserDiscoveryServerHandle["ready"]>;
}>;
async function startServer(
  connectMcpOAuth: (request: BrowserDeviceMcpOAuthRequest) => Promise<void>,
): Promise<{
  handle: BrowserDiscoveryServerHandle;
  address: Awaited<BrowserDiscoveryServerHandle["ready"]>;
}>;
async function startServer(
  connectMcpOAuth?: (request: BrowserDeviceMcpOAuthRequest) => Promise<void>,
): Promise<{
  handle: BrowserDiscoveryServerHandle;
  address: Awaited<BrowserDiscoveryServerHandle["ready"]>;
}> {
  const handle = startBrowserDiscoveryServer({
    ...(connectMcpOAuth ? { connectMcpOAuth } : {}),
    port: 0,
  });
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

async function buildNodeFixture(body: string): Promise<string> {
  const directory = await mkdtemp(
    join(process.cwd(), ".browser-discovery-node-"),
  );
  tempDirs.push(directory);
  const entrypoint = join(directory, "fixture.ts");
  const output = join(directory, "fixture.js");
  const modulePath = relative(
    directory,
    join(process.cwd(), "src/browser-discovery-server.ts"),
  ).replaceAll("\\", "/");
  const moduleSpecifier = modulePath.startsWith(".")
    ? modulePath
    : `./${modulePath}`;
  await writeFile(
    entrypoint,
    `import { startBrowserDiscoveryServer } from ${JSON.stringify(moduleSpecifier)};\n${body}`,
  );
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: directory,
    naming: { entry: "fixture.js" },
    target: "node",
    format: "esm",
  });
  if (!result.success) {
    throw new Error(
      `Could not build Node discovery fixture: ${result.logs.join("\n")}`,
    );
  }
  return output;
}

async function readFirstLine(
  child: ReturnType<typeof spawn>,
  getStderr: () => string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for Node fixture output: ${getStderr()}`),
      );
    }, 2_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(output.slice(0, newline));
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      reject(
        new Error(
          `Node fixture exited before reporting its address (${code ?? signal}): ${getStderr()}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  getStderr: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Node discovery fixture stayed alive with an accepted socket: ${getStderr()}`,
        ),
      );
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
