import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { AgentCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
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

const TEST_TIMEOUT_MS = 5000;

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

function waitForCloseEvent(
  socket: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket close event"));
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", handleClose);
    };
    const handleClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString() });
    };
    socket.once("close", handleClose);
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

afterEach(() => {
  __testSetBackend(null);
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
      stream = new WebSocket(handle.streamUrl);
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
      stream = new WebSocket(handle.streamUrl);
      await waitForOpen(stream);

      await waitForClientClose(stream);
      expect(stream.readyState).not.toBe(WebSocket.OPEN);
    } finally {
      closeClient(stream);
      await handle?.close();
    }
  });

  test("preempts an existing control connection for a newer client", async () => {
    let handle: AppServerHandle | null = null;
    let first: WebSocket | null = null;
    let second: WebSocket | null = null;
    const logs: string[] = [];
    try {
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        onLog: (message) => logs.push(message),
      });
      first = new WebSocket(handle.controlUrl);
      await waitForOpen(first);

      const firstClosed = waitForCloseEvent(first);
      second = new WebSocket(handle.controlUrl);
      await waitForOpen(second);

      expect(await firstClosed).toEqual({
        code: 4000,
        reason: "superseded by newer connection",
      });
      expect(logs).toContainEqual(
        expect.stringContaining("superseded the active session"),
      );

      // The newcomer keeps the slot after the holder is gone.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(second.readyState).toBe(WebSocket.OPEN);
    } finally {
      terminateClient(first);
      terminateClient(second);
      await handle?.close();
    }
  });

  test("frees the control slot for reconnects without waiting for the dead-peer watchdog", async () => {
    let handle: AppServerHandle | null = null;
    let zombie: WebSocket | null = null;
    let successor: WebSocket | null = null;
    try {
      // The zombie never answers protocol pings, and the watchdog timeout is
      // far beyond the test window, so only preemption can free the slot.
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        heartbeatIntervalMs: 25,
        pongTimeoutMs: 60_000,
      });
      zombie = new WebSocket(handle.controlUrl, { autoPong: false });
      await waitForOpen(zombie);

      successor = new WebSocket(handle.controlUrl);
      await waitForOpen(successor);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(successor.readyState).toBe(WebSocket.OPEN);
    } finally {
      terminateClient(zombie);
      terminateClient(successor);
      await handle?.close();
    }
  });

  test("supersedes the paired session when a newer stream connection arrives", async () => {
    let handle: AppServerHandle | null = null;
    let control1: WebSocket | null = null;
    let stream1: WebSocket | null = null;
    let control2: WebSocket | null = null;
    let stream2: WebSocket | null = null;
    try {
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      control1 = new WebSocket(handle.controlUrl);
      await waitForOpen(control1);
      stream1 = new WebSocket(handle.streamUrl);
      await waitForOpen(stream1);

      const control1Closed = waitForCloseEvent(control1);
      const stream1Closed = waitForCloseEvent(stream1);
      stream2 = new WebSocket(handle.streamUrl);
      await waitForOpen(stream2);

      expect(await stream1Closed).toMatchObject({ code: 4000 });
      expect(await control1Closed).toMatchObject({ code: 4000 });

      // The superseding stream socket is seated as pending and pairs with the
      // newcomer's control channel.
      control2 = new WebSocket(handle.controlUrl);
      await waitForOpen(control2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(control2.readyState).toBe(WebSocket.OPEN);
      expect(stream2.readyState).toBe(WebSocket.OPEN);
    } finally {
      terminateClient(control1);
      terminateClient(stream1);
      terminateClient(control2);
      terminateClient(stream2);
      await handle?.close();
    }
  });

  test("replaces a pending stream socket with a newer stream connection", async () => {
    let handle: AppServerHandle | null = null;
    let stream1: WebSocket | null = null;
    let stream2: WebSocket | null = null;
    let control: WebSocket | null = null;
    try {
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      stream1 = new WebSocket(handle.streamUrl);
      await waitForOpen(stream1);

      const stream1Closed = waitForCloseEvent(stream1);
      stream2 = new WebSocket(handle.streamUrl);
      await waitForOpen(stream2);
      expect(await stream1Closed).toMatchObject({ code: 4000 });

      control = new WebSocket(handle.controlUrl);
      await waitForOpen(control);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stream2.readyState).toBe(WebSocket.OPEN);
    } finally {
      terminateClient(stream1);
      terminateClient(stream2);
      terminateClient(control);
      await handle?.close();
    }
  });

  test("closes the paired control channel when stream disconnects", async () => {
    let handle: AppServerHandle | null = null;
    try {
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });

      for (const order of ["stream-first", "control-first"] as const) {
        const firstUrl =
          order === "stream-first" ? handle.streamUrl : handle.controlUrl;
        const secondUrl =
          order === "stream-first" ? handle.controlUrl : handle.streamUrl;
        const first = new WebSocket(firstUrl);
        await waitForOpen(first);
        const second = new WebSocket(secondUrl);
        await waitForOpen(second);
        const stream = order === "stream-first" ? first : second;
        const control = order === "stream-first" ? second : first;

        terminateClient(stream);
        await waitForClientClose(control);
        terminateClient(control);
      }
    } finally {
      await handle?.close();
    }
  });

  test("starts a runtime over control and emits state frames over stream", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "letta-app-server-"));
    let handle: AppServerHandle | null = null;
    let control: WebSocket | null = null;
    let stream: WebSocket | null = null;
    try {
      __testSetBackend(
        new LocalBackend({ storageDir, executionMode: "deterministic" }),
      );
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      stream = new WebSocket(handle.streamUrl);
      control = new WebSocket(handle.controlUrl);
      await Promise.all([waitForOpen(stream), waitForOpen(control)]);

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
        stream,
        (message) =>
          message.type === "update_device_status" &&
          JSON.stringify(message.runtime) === JSON.stringify(runtime),
      );

      const loopStatus = await waitForJsonMessage(stream, (message) => {
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
      closeClient(stream);
      await handle?.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
