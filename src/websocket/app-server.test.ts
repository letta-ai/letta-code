import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import {
  type AppServerHandle,
  parseAppServerListenUrl,
  startAppServer,
} from "@/websocket/app-server";
import {
  authorizeUpgrade,
  isUnauthenticatedNonLoopbackListener,
  parseAppServerWebsocketAuthSettings,
  policyFromSettings,
} from "@/websocket/app-server-auth";
import { getActiveRuntime } from "@/websocket/listener/runtime";

const TEST_TIMEOUT_MS = 30_000;
const ORIGINAL_DISABLE_MODS = process.env.LETTA_DISABLE_MODS;
const ORIGINAL_DISABLE_CRON = process.env.LETTA_DISABLE_CRON_SCHEDULER;

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket open"));
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("open", handleOpen);
    socket.once("error", handleError);
  });
}

function expectWebSocketOpenFailure(
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  const socket = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      terminateClient(socket);
      reject(new Error("Timed out waiting for websocket rejection"));
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      terminateClient(socket);
      reject(new Error("Expected websocket connection to be rejected"));
    };
    const handleError = () => {
      cleanup();
      terminateClient(socket);
      resolve();
    };
    socket.once("open", handleOpen);
    socket.once("error", handleError);
  });
}

function waitForJsonMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const seen: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for websocket message; saw ${JSON.stringify(seen)}`,
        ),
      );
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", handleMessage);
      socket.off("error", handleError);
    };
    const handleMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      seen.push(parsed);
      if (!predicate(parsed)) {
        return;
      }
      cleanup();
      resolve(parsed);
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("message", handleMessage);
    socket.once("error", handleError);
  });
}

function waitForClientPing(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for server ping"));
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("ping", handlePing);
      socket.off("error", handleError);
    };
    const handlePing = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("ping", handlePing);
    socket.once("error", handleError);
  });
}

function waitForClientClose(socket: WebSocket): Promise<void> {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket close"));
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", handleClose);
    };
    const handleClose = () => {
      cleanup();
      resolve();
    };
    socket.once("close", handleClose);
  });
}

function closeClient(socket: WebSocket | null): void {
  if (!socket) return;
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

function terminateClient(socket: WebSocket | null): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  socket.terminate();
}

function loopbackChannelUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = "127.0.0.1";
  return parsed.toString();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signedBearerToken(
  sharedSecret: string,
  claims: Record<string, unknown>,
): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claimsSegment = base64Url(JSON.stringify(claims));
  const payload = `${header}.${claimsSegment}`;
  const signature = createHmac("sha256", sharedSecret).update(payload).digest();
  return `${payload}.${base64Url(signature)}`;
}

beforeEach(() => {
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
});

afterEach(() => {
  __testSetBackend(null);
  if (ORIGINAL_DISABLE_MODS === undefined) {
    delete process.env.LETTA_DISABLE_MODS;
  } else {
    process.env.LETTA_DISABLE_MODS = ORIGINAL_DISABLE_MODS;
  }
  if (ORIGINAL_DISABLE_CRON === undefined) {
    delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
  } else {
    process.env.LETTA_DISABLE_CRON_SCHEDULER = ORIGINAL_DISABLE_CRON;
  }
});

describe("app-server native websocket", () => {
  test("parses websocket listen URLs", () => {
    expect(parseAppServerListenUrl()).toEqual({
      host: "127.0.0.1",
      port: 0,
      path: "/ws",
    });
    expect(parseAppServerListenUrl("ws://localhost:4500/custom")).toEqual({
      host: "localhost",
      port: 4500,
      path: "/custom",
    });
    expect(() => parseAppServerListenUrl("stdio://")).toThrow(
      /only supports ws:\/\//,
    );
    expect(parseAppServerListenUrl("ws://0.0.0.0:4500")).toEqual({
      host: "0.0.0.0",
      port: 4500,
      path: "/ws",
    });
  });

  test("parses capability-token websocket auth settings", async () => {
    expect(() =>
      parseAppServerWebsocketAuthSettings({ wsAuth: "capability-token" }),
    ).toThrow(/--ws-token-file.*--ws-token-sha256/);
    expect(() =>
      parseAppServerWebsocketAuthSettings({
        wsAuth: "capability-token",
        wsTokenFile: "/tmp/token",
        wsTokenSha256: "ab".repeat(32),
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      parseAppServerWebsocketAuthSettings({
        wsAuth: "capability-token",
        wsTokenSha256: "not-a-sha256",
      }),
    ).toThrow(/64-character hex/);

    const settings = parseAppServerWebsocketAuthSettings({
      wsAuth: "capability-token",
      wsTokenSha256: sha256Hex("super-secret-token"),
    });
    const policy = await policyFromSettings(settings);
    expect(isUnauthenticatedNonLoopbackListener("0.0.0.0", {})).toBe(true);
    expect(isUnauthenticatedNonLoopbackListener("127.0.0.2", {})).toBe(false);
    expect(isUnauthenticatedNonLoopbackListener("0.0.0.0", policy)).toBe(false);
    expect(
      authorizeUpgrade({ authorization: "Bearer super-secret-token" }, policy),
    ).toBeNull();
    expect(authorizeUpgrade({}, policy)).toMatchObject({ statusCode: 401 });
    expect(
      authorizeUpgrade({ authorization: "Bearer wrong-token" }, policy),
    ).toMatchObject({ statusCode: 401 });
  });

  test("parses signed-bearer websocket auth settings", async () => {
    const authDir = await mkdtemp(join(os.tmpdir(), "letta-app-server-jwt-"));
    const sharedSecretFile = join(authDir, "app-server-signing-secret");
    const shortSecretFile = join(authDir, "app-server-short-secret");
    try {
      await writeFile(
        sharedSecretFile,
        "0123456789abcdef0123456789abcdef\n",
        "utf8",
      );
      await writeFile(shortSecretFile, "too-short\n", "utf8");

      expect(() =>
        parseAppServerWebsocketAuthSettings({
          wsAuth: "signed-bearer-token",
        }),
      ).toThrow(/--ws-shared-secret-file/);
      expect(() =>
        parseAppServerWebsocketAuthSettings({
          wsAuth: "signed-bearer-token",
          wsSharedSecretFile: sharedSecretFile,
          wsTokenSha256: "ab".repeat(32),
        }),
      ).toThrow(/capability-token/);
      expect(() =>
        parseAppServerWebsocketAuthSettings({
          wsSharedSecretFile: sharedSecretFile,
        }),
      ).toThrow(/signed-bearer-token/);
      await expect(
        policyFromSettings(
          parseAppServerWebsocketAuthSettings({
            wsAuth: "signed-bearer-token",
            wsSharedSecretFile: shortSecretFile,
          }),
        ),
      ).rejects.toThrow(/at least 32 bytes/);

      const policy = await policyFromSettings(
        parseAppServerWebsocketAuthSettings({
          wsAuth: "signed-bearer-token",
          wsSharedSecretFile: sharedSecretFile,
          wsIssuer: " codex-enroller ",
          wsAudience: "codex-app-server",
          wsMaxClockSkewSeconds: "1",
        }),
      );
      const now = Math.floor(Date.now() / 1000);
      const validToken = signedBearerToken("0123456789abcdef0123456789abcdef", {
        exp: now + 60,
        iss: "codex-enroller",
        aud: "codex-app-server",
      });
      expect(
        authorizeUpgrade({ authorization: `Bearer ${validToken}` }, policy),
      ).toBeNull();

      const expiredToken = signedBearerToken(
        "0123456789abcdef0123456789abcdef",
        {
          exp: now - 30,
          iss: "codex-enroller",
          aud: "codex-app-server",
        },
      );
      expect(
        authorizeUpgrade({ authorization: `Bearer ${expiredToken}` }, policy),
      ).toMatchObject({ statusCode: 401 });
    } finally {
      await rm(authDir, { recursive: true, force: true });
    }
  });

  test("serves health probes", async () => {
    let handle: AppServerHandle | null = null;
    try {
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      const httpUrl = handle.url.replace(/^ws:/, "http:");

      const ready = await fetch(`${httpUrl}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.text()).toBe("ok\n");

      const health = await fetch(`${httpUrl}/healthz`);
      expect(health.status).toBe(200);

      const browserHealth = await fetch(`${httpUrl}/healthz`, {
        headers: { Origin: "https://example.com" },
      });
      expect(browserHealth.status).toBe(403);

      const browserReady = await fetch(`${httpUrl}/readyz`, {
        headers: { Origin: "https://example.com" },
      });
      expect(browserReady.status).toBe(403);
    } finally {
      await handle?.close();
    }
  });

  test("rejects origin-bearing websocket upgrades without auth", async () => {
    let handle: AppServerHandle | null = null;
    const logs: string[] = [];
    try {
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        onLog: (message) => logs.push(message),
      });
      await expectWebSocketOpenFailure(handle.controlUrl, {
        Origin: "https://evil.example",
      });
      await expectWebSocketOpenFailure(handle.controlUrl, { Origin: "" });
      expect(logs).toEqual([
        expect.stringContaining("--ws-auth capability-token"),
        expect.stringContaining("--ws-auth capability-token"),
      ]);
    } finally {
      await handle?.close();
    }
  });

  test("requires capability-token auth for non-loopback websocket listeners", async () => {
    await expect(startAppServer({ listen: "ws://0.0.0.0:0" })).rejects.toThrow(
      /without auth/,
    );
  });

  test("rejects missing and invalid capability tokens", async () => {
    const authDir = await mkdtemp(join(os.tmpdir(), "letta-app-server-auth-"));
    const tokenFile = join(authDir, "app-server-token");
    let handle: AppServerHandle | null = null;
    let control: WebSocket | null = null;
    try {
      await writeFile(tokenFile, "super-secret-token\n", "utf8");
      handle = await startAppServer({
        listen: "ws://0.0.0.0:0",
        websocketAuth: parseAppServerWebsocketAuthSettings({
          wsAuth: "capability-token",
          wsTokenFile: tokenFile,
        }),
      });
      const controlUrl = loopbackChannelUrl(handle.controlUrl);
      const infoUrl = new URL(controlUrl);
      infoUrl.protocol = "http:";
      infoUrl.pathname = "/app-server-info";
      infoUrl.search = "";

      expect((await fetch(infoUrl)).status).toBe(401);
      expect(
        (
          await fetch(infoUrl, {
            headers: { Authorization: "Bearer wrong-token" },
          })
        ).status,
      ).toBe(401);
      const infoResponse = await fetch(infoUrl, {
        headers: { Authorization: "Bearer super-secret-token" },
      });
      expect(infoResponse.status).toBe(200);
      expect(await infoResponse.json()).toMatchObject({
        type: "app_server_info_response",
        protocol_version: 1,
      });

      await expectWebSocketOpenFailure(controlUrl);
      await expectWebSocketOpenFailure(controlUrl, {
        Authorization: "Bearer wrong-token",
        Origin: "http://localhost:8081",
      });

      control = new WebSocket(controlUrl, {
        headers: {
          Authorization: "Bearer super-secret-token",
          Origin: "http://localhost:8081",
        },
      });
      await waitForOpen(control);
    } finally {
      terminateClient(control);
      await handle?.close();
      await rm(authDir, { recursive: true, force: true });
    }
  });

  test("rejects invalid and accepts valid signed bearer tokens", async () => {
    const authDir = await mkdtemp(join(os.tmpdir(), "letta-app-server-jwt-"));
    const sharedSecretFile = join(authDir, "app-server-signing-secret");
    const sharedSecret = "0123456789abcdef0123456789abcdef";
    let handle: AppServerHandle | null = null;
    let control: WebSocket | null = null;
    try {
      await writeFile(sharedSecretFile, `${sharedSecret}\n`, "utf8");
      handle = await startAppServer({
        listen: "ws://0.0.0.0:0",
        websocketAuth: parseAppServerWebsocketAuthSettings({
          wsAuth: "signed-bearer-token",
          wsSharedSecretFile: sharedSecretFile,
          wsIssuer: "codex-enroller",
          wsAudience: "codex-app-server",
          wsMaxClockSkewSeconds: "1",
        }),
      });
      const controlUrl = loopbackChannelUrl(handle.controlUrl);
      const now = Math.floor(Date.now() / 1000);

      const expiredToken = signedBearerToken(sharedSecret, {
        exp: now - 30,
        iss: "codex-enroller",
        aud: "codex-app-server",
      });
      await expectWebSocketOpenFailure(controlUrl, {
        Authorization: `Bearer ${expiredToken}`,
        Origin: "http://localhost:8081",
      });

      const validToken = signedBearerToken(sharedSecret, {
        exp: now + 60,
        iss: "codex-enroller",
        aud: "codex-app-server",
      });
      control = new WebSocket(controlUrl, {
        headers: {
          Authorization: `Bearer ${validToken}`,
          Origin: "http://localhost:8081",
        },
      });
      await waitForOpen(control);
    } finally {
      terminateClient(control);
      await handle?.close();
      await rm(authDir, { recursive: true, force: true });
    }
  });

  test("pings connected clients and keeps healthy sockets open", async () => {
    let handle: AppServerHandle | null = null;
    let stream: WebSocket | null = null;
    try {
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        heartbeatIntervalMs: 25,
        pongTimeoutMs: 5000,
      });
      stream = new WebSocket(handle.controlUrl);
      await waitForOpen(stream);

      // The watchdog should ping connected clients on its cadence.
      await waitForClientPing(stream);

      // The `ws` client auto-pongs, so a healthy socket survives multiple
      // intervals without being reaped.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(stream.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeClient(stream);
      await handle?.close();
    }
  });

  test("terminates sockets that exceed the pong timeout", async () => {
    let handle: AppServerHandle | null = null;
    let stream: WebSocket | null = null;
    try {
      // A 1ms pong timeout means the seeded connect timestamp is already stale
      // by the first interval tick, so the watchdog reaps the socket.
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        heartbeatIntervalMs: 25,
        pongTimeoutMs: 1,
      });
      stream = new WebSocket(handle.controlUrl);
      await waitForOpen(stream);

      await waitForClientClose(stream);
      expect(stream.readyState).not.toBe(WebSocket.OPEN);
    } finally {
      closeClient(stream);
      await handle?.close();
    }
  });

  test("rejects legacy split-channel websocket URLs", async () => {
    let handle: AppServerHandle | null = null;
    try {
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      expect("streamUrl" in handle).toBe(false);
      const legacyStreamUrl = new URL(handle.controlUrl);
      legacyStreamUrl.searchParams.set("channel", "stream");
      await expectWebSocketOpenFailure(legacyStreamUrl.toString());
      const legacyControlUrl = new URL(handle.controlUrl);
      legacyControlUrl.searchParams.set("channel", "control");
      await expectWebSocketOpenFailure(legacyControlUrl.toString());
    } finally {
      await handle?.close();
    }
  });

  test("disconnecting one client leaves another client usable", async () => {
    let handle: AppServerHandle | null = null;
    let first: WebSocket | null = null;
    let second: WebSocket | null = null;
    try {
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      first = new WebSocket(handle.controlUrl);
      second = new WebSocket(handle.controlUrl);
      await Promise.all([waitForOpen(first), waitForOpen(second)]);

      terminateClient(second);
      await waitForClientClose(second);

      const response = waitForJsonMessage(
        first,
        (message) =>
          message.type === "app_server_info_response" &&
          message.request_id === "peer-still-healthy",
      );
      first.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "peer-still-healthy",
        }),
      );
      expect(await response).toMatchObject({
        type: "app_server_info_response",
        request_id: "peer-still-healthy",
        success: true,
      });
      expect(first.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeClient(first);
      closeClient(second);
      await handle?.close();
    }
  });

  test("a heartbeat reap removes only the unresponsive client", async () => {
    let handle: AppServerHandle | null = null;
    let first: WebSocket | null = null;
    let second: WebSocket | null = null;
    try {
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        heartbeatIntervalMs: 20,
        pongTimeoutMs: 60,
        shouldRecordPong: (connectionId) => connectionId !== "app-server-1",
      });
      first = new WebSocket(handle.controlUrl);
      second = new WebSocket(handle.controlUrl);
      await Promise.all([waitForOpen(first), waitForOpen(second)]);

      await waitForClientClose(second);
      expect(first.readyState).toBe(WebSocket.OPEN);

      const response = waitForJsonMessage(
        first,
        (message) =>
          message.type === "app_server_info_response" &&
          message.request_id === "healthy-after-reap",
      );
      first.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "healthy-after-reap",
        }),
      );
      await response;
      expect(getActiveRuntime()?.connections.size).toBe(1);
    } finally {
      closeClient(first);
      closeClient(second);
      await handle?.close();
    }
  });

  test("routes simultaneous clients, subscriptions, and identical ids independently", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "letta-app-server-multi-"),
    );
    let handle: AppServerHandle | null = null;
    let clientA: WebSocket | null = null;
    let clientB: WebSocket | null = null;
    const seenA: Record<string, unknown>[] = [];
    const seenB: Record<string, unknown>[] = [];
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
        memfsEnabled: false,
      });
      __testSetBackend(backend);
      const createAgent = (name: string) =>
        backend.createAgent({
          name,
          model: "anthropic/claude-sonnet-4-6",
        } as AgentCreateBody);
      const [agentA, agentB] = await Promise.all([
        createAgent("Client A"),
        createAgent("Client B"),
      ]);
      await settingsManager.initialize();
      settingsManager.setMemfsEnabled(agentA.id, false);
      settingsManager.setMemfsEnabled(agentB.id, false);
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      clientA = new WebSocket(handle.controlUrl);
      clientB = new WebSocket(handle.controlUrl);
      clientA.on("message", (raw) => {
        seenA.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });
      clientB.on("message", (raw) => {
        seenB.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });
      await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);
      const startA = waitForJsonMessage(
        clientA,
        (message) =>
          message.type === "runtime_start_response" &&
          message.request_id === "identical-runtime-start-id",
      );
      const startB = waitForJsonMessage(
        clientB,
        (message) =>
          message.type === "runtime_start_response" &&
          message.request_id === "identical-runtime-start-id",
      );
      const runtimeStart = (agentId: string, name: string) =>
        JSON.stringify({
          type: "runtime_start",
          request_id: "identical-runtime-start-id",
          agent_id: agentId,
          create_conversation: { body: { summary: `${name} conversation` } },
          recover_approvals: false,
        });
      clientA.send(runtimeStart(agentA.id, "Client A"));
      clientB.send(runtimeStart(agentB.id, "Client B"));
      const [responseA, responseB] = await Promise.all([startA, startB]);
      type RuntimeScope = { agent_id: string; conversation_id: string };
      const runtimeA = responseA.runtime as RuntimeScope;
      const runtimeB = responseB.runtime as RuntimeScope;
      expect(runtimeA.agent_id).not.toBe(runtimeB.agent_id);
      expect(responseA.agent).toMatchObject({ name: "Client A" });
      expect(responseB.agent).toMatchObject({ name: "Client B" });
      expect(
        seenA.filter(
          (message) =>
            message.type === "runtime_start_response" &&
            message.request_id === "identical-runtime-start-id",
        ),
      ).toHaveLength(1);
      expect(
        seenB.filter(
          (message) =>
            message.type === "runtime_start_response" &&
            message.request_id === "identical-runtime-start-id",
        ),
      ).toHaveLength(1);
      seenA.length = 0;
      seenB.length = 0;
      const waitForTurn = (socket: WebSocket, runtime: typeof runtimeA) =>
        waitForJsonMessage(socket, (message) => {
          const scope = message.runtime as typeof runtime | undefined;
          const delta = message.delta as { message_type?: unknown } | undefined;
          return (
            message.type === "stream_delta" &&
            scope?.agent_id === runtime.agent_id &&
            scope?.conversation_id === runtime.conversation_id &&
            delta?.message_type === "stop_reason"
          );
        });
      const inputFor = (runtime: typeof runtimeA) =>
        JSON.stringify({
          type: "input",
          runtime,
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "concurrent ping" }],
          },
        });
      const concurrentA = waitForTurn(clientA, runtimeA);
      const concurrentB = waitForTurn(clientB, runtimeB);
      clientA.send(inputFor(runtimeA));
      clientB.send(inputFor(runtimeB));
      await Promise.all([concurrentA, concurrentB]);
      expect(
        seenA.some(
          (message) =>
            (message.runtime as { agent_id?: unknown } | undefined)
              ?.agent_id === runtimeB.agent_id,
        ),
      ).toBe(false);
      expect(
        seenB.some(
          (message) =>
            (message.runtime as { agent_id?: unknown } | undefined)
              ?.agent_id === runtimeA.agent_id,
        ),
      ).toBe(false);
      const turnFinished = waitForJsonMessage(clientA, (message) => {
        const runtime = message.runtime as
          | { agent_id?: unknown; conversation_id?: unknown }
          | undefined;
        const delta = message.delta as { message_type?: unknown } | undefined;
        return (
          message.type === "stream_delta" &&
          runtime?.agent_id === runtimeA.agent_id &&
          runtime?.conversation_id === runtimeA.conversation_id &&
          delta?.message_type === "stop_reason"
        );
      });
      const managementResponse = waitForJsonMessage(
        clientB,
        (message) =>
          message.type === "app_server_info_response" &&
          message.request_id === "management-during-turn",
      );
      clientA.send(
        JSON.stringify({
          type: "input",
          runtime: runtimeA,
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "ping" }],
          },
        }),
      );
      clientB.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "management-during-turn",
        }),
      );
      await Promise.all([turnFinished, managementResponse]);
      expect(
        seenB.some((message) => {
          const runtime = message.runtime as { agent_id?: unknown } | undefined;
          return runtime?.agent_id === runtimeA.agent_id;
        }),
      ).toBe(false);

      const subscribeB = waitForJsonMessage(
        clientB,
        (message) =>
          message.type === "runtime_start_response" &&
          message.request_id === "subscribe-existing-runtime",
      );
      clientB.send(
        JSON.stringify({
          type: "runtime_start",
          request_id: "subscribe-existing-runtime",
          agent_id: runtimeA.agent_id,
          conversation_id: runtimeA.conversation_id,
          recover_approvals: false,
        }),
      );
      await subscribeB;

      const statusForA = waitForJsonMessage(
        clientA,
        (message) =>
          message.type === "update_loop_status" &&
          (message.runtime as { agent_id?: unknown } | undefined)?.agent_id ===
            runtimeA.agent_id,
      );
      const statusForB = waitForJsonMessage(
        clientB,
        (message) =>
          message.type === "update_loop_status" &&
          (message.runtime as { agent_id?: unknown } | undefined)?.agent_id ===
            runtimeA.agent_id,
      );
      const syncResponse = waitForJsonMessage(
        clientA,
        (message) =>
          message.type === "sync_response" &&
          message.request_id === "identical-direct-id",
      );
      const infoResponse = waitForJsonMessage(
        clientB,
        (message) =>
          message.type === "app_server_info_response" &&
          message.request_id === "identical-direct-id",
      );
      clientA.send(
        JSON.stringify({
          type: "sync",
          request_id: "identical-direct-id",
          runtime: runtimeA,
          recover_approvals: false,
          force_device_status: true,
        }),
      );
      clientB.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "identical-direct-id",
        }),
      );
      await Promise.all([statusForA, statusForB, syncResponse, infoResponse]);
      expect(
        seenA.some(
          (message) =>
            message.type === "app_server_info_response" &&
            message.request_id === "identical-direct-id",
        ),
      ).toBe(false);
      expect(
        seenB.some(
          (message) =>
            message.type === "sync_response" &&
            message.request_id === "identical-direct-id",
        ),
      ).toBe(false);

      expect(getActiveRuntime()?.processServicesStarted).toBe(true);
      expect(getActiveRuntime()?.connections.size).toBe(2);
      terminateClient(clientB);
      await waitForClientClose(clientB);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getActiveRuntime()?.connections.size).toBe(1);

      const afterDisconnect = waitForJsonMessage(
        clientA,
        (message) =>
          message.type === "app_server_info_response" &&
          message.request_id === "client-a-survives",
      );
      clientA.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "client-a-survives",
        }),
      );
      await afterDisconnect;
    } finally {
      closeClient(clientA);
      closeClient(clientB);
      await handle?.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("starts a runtime and emits state frames over the same socket", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "letta-app-server-"));
    let handle: AppServerHandle | null = null;
    let control: WebSocket | null = null;
    try {
      __testSetBackend(
        new LocalBackend({ storageDir, executionMode: "deterministic" }),
      );
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      control = new WebSocket(handle.controlUrl);
      await waitForOpen(control);

      control.send(
        JSON.stringify({
          type: "runtime_start",
          request_id: "runtime-start-1",
          create_agent: {
            body: {
              name: "App Server Agent",
              model: "anthropic/claude-sonnet-4-6",
            } as AgentCreateBody,
            pin_global: false,
          },
          create_conversation: {
            body: { summary: "App server conversation" },
          },
          recover_approvals: false,
        }),
      );

      const startResponse = await waitForJsonMessage(
        control,
        (message) => message.type === "runtime_start_response",
      );
      expect(startResponse).toMatchObject({
        type: "runtime_start_response",
        request_id: "runtime-start-1",
        success: true,
        created: { agent: true, conversation: true },
      });
      const runtime = startResponse.runtime as {
        agent_id: string;
        conversation_id: string;
      };

      await waitForJsonMessage(
        control,
        (message) =>
          message.type === "update_device_status" &&
          JSON.stringify(message.runtime) === JSON.stringify(runtime),
      );

      const loopStatus = await waitForJsonMessage(control, (message) => {
        const loopStatus = message.loop_status as
          | { status?: unknown }
          | undefined;
        return (
          message.type === "update_loop_status" &&
          loopStatus?.status === "WAITING_ON_INPUT" &&
          JSON.stringify(message.runtime) === JSON.stringify(runtime)
        );
      });

      expect(loopStatus).toMatchObject({
        type: "update_loop_status",
        runtime,
        loop_status: { status: "WAITING_ON_INPUT" },
      });
    } finally {
      closeClient(control);
      await handle?.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
