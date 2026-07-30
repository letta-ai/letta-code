import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { OAuthRefreshError, type TokenResponse } from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";
import type { ControlRequest } from "@/types/protocol_v2";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import { requestApprovalOverWS } from "@/websocket/listener/approval";
import { __listenerAuthTestUtils } from "@/websocket/listener/auth";
import {
  getOrCreateProcessTransport,
  subscribeListenerConnection,
  TO_SUBSCRIBERS,
} from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import {
  emitLoopStatusUpdate,
  emitProtocolV2Message,
} from "@/websocket/listener/protocol-outbound";
import { getActiveRuntime } from "@/websocket/listener/runtime";

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("listener auth lifecycle", () => {
  const originalHome = process.env.HOME;
  const originalDisableCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;
  const originalDisableMods = process.env.LETTA_DISABLE_MODS;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalUpdateSettings = settingsManager.updateSettings;
  const originalFlush = settingsManager.flush;

  let testHome: string;
  let server: WebSocketServer;
  let wsUrl: string;
  let settings: ListenerSettings;
  let connections: WebSocket[];
  let connectionChannels: Array<string | null>;
  let authorizations: Array<string | undefined>;
  let messagesByConnection: WeakMap<WebSocket, unknown[]>;

  const refreshAccessTokenMock = mock(async (): Promise<TokenResponse> => {
    throw new Error("refreshAccessToken not mocked");
  });

  beforeEach(async () => {
    stopListenerClient();
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-listener-auth-"));
    process.env.HOME = testHome;
    process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
    process.env.LETTA_DISABLE_MODS = "1";
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;
    await settingsManager.initialize();

    settings = {
      ...settingsManager.getSettings(),
      env: { LETTA_API_KEY: "initial-access-token" },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    };
    refreshAccessTokenMock.mockReset();
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      refreshAccessToken: refreshAccessTokenMock,
    });
    settingsManager.getSettingsWithSecureTokens = mock(
      async () => settings,
    ) as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings = mock((updates) => {
      settings = {
        ...settings,
        ...updates,
        env: { ...settings.env, ...updates.env },
      };
    }) as typeof settingsManager.updateSettings;
    settingsManager.flush = mock(
      async () => {},
    ) as typeof settingsManager.flush;

    connections = [];
    connectionChannels = [];
    authorizations = [];
    messagesByConnection = new WeakMap();
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}`;
    server.on("connection", (socket, request) => {
      connections.push(socket);
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      connectionChannels.push(requestUrl.searchParams.get("channel"));
      authorizations.push(request.headers.authorization);
      const messages: unknown[] = [];
      messagesByConnection.set(socket, messages);
      socket.on("message", (data) => {
        try {
          messages.push(JSON.parse(data.toString()));
        } catch {
          messages.push(data.toString());
        }
      });
    });
  });

  afterEach(async () => {
    stopListenerClient();
    await Promise.all(
      [...server.clients].map(
        (connection) =>
          new Promise<void>((resolve) => {
            if (connection.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            connection.once("close", () => resolve());
            connection.terminate();
          }),
      ),
    );
    server.close();
    __listenerAuthTestUtils.setOAuthDepsForTests(null);
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.updateSettings = originalUpdateSettings;
    settingsManager.flush = originalFlush;
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });

    process.env.HOME = originalHome;
    if (originalDisableCron === undefined) {
      delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
    } else {
      process.env.LETTA_DISABLE_CRON_SCHEDULER = originalDisableCron;
    }
    if (originalDisableMods === undefined) {
      delete process.env.LETTA_DISABLE_MODS;
    } else {
      process.env.LETTA_DISABLE_MODS = originalDisableMods;
    }
    if (originalApiKey === undefined) {
      delete process.env.LETTA_API_KEY;
    } else {
      process.env.LETTA_API_KEY = originalApiKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }
  });

  function startClient(
    overrides: {
      onConnected?: (connectionId?: string) => void;
      onDisconnected?: () => void;
      onNeedsReregister?: () => void;
      onError?: (error: Error) => void;
      supportsSplitStatusChannels?: boolean;
    } = {},
  ) {
    return startListenerClient({
      connectionId: "connection-id",
      wsUrl,
      deviceId: "device-id",
      connectionName: "listener-name",
      supportsSplitStatusChannels: overrides.supportsSplitStatusChannels,
      onConnected: overrides.onConnected ?? mock(() => {}),
      onDisconnected: overrides.onDisconnected ?? mock(() => {}),
      onNeedsReregister: overrides.onNeedsReregister ?? mock(() => {}),
      onError: overrides.onError ?? mock(() => {}),
    });
  }

  function makeControlRequest(requestId: string): ControlRequest {
    return {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: {},
        tool_call_id: requestId.replace("perm-", "call-"),
        permission_suggestions: [],
        blocked_path: null,
      },
    };
  }

  function countConnectionsForChannel(channel: string): number {
    return connectionChannels.filter((value) => value === channel).length;
  }

  function lastConnectionIndexForChannel(channel: string): number {
    for (let index = connectionChannels.length - 1; index >= 0; index -= 1) {
      if (connectionChannels[index] === channel) return index;
    }
    return -1;
  }

  function getConnectionMessages(index: number): unknown[] {
    const socket = connections[index];
    if (!socket) {
      return [];
    }
    return messagesByConnection.get(socket) ?? [];
  }

  function hasPendingApprovalSnapshot(
    connectionIndex: number,
    requestId: string,
  ): boolean {
    return getConnectionMessages(connectionIndex).some((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      const candidate = message as {
        type?: string;
        device_status?: {
          pending_control_requests?: Array<{ request_id?: string }>;
        };
      };
      return (
        candidate.type === "update_device_status" &&
        candidate.device_status?.pending_control_requests?.some(
          (request) => request.request_id === requestId,
        ) === true
      );
    });
  }

  function hasLoopStatusSnapshot(
    connectionIndex: number,
    status: string,
  ): boolean {
    return getConnectionMessages(connectionIndex).some((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      const candidate = message as {
        type?: string;
        loop_status?: { status?: string };
      };
      return (
        candidate.type === "update_loop_status" &&
        candidate.loop_status?.status === status
      );
    });
  }

  test("refreshes missing credentials on a real socket reconnect", async () => {
    await startClient();
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );
    expect(authorizations[0]).toBe("Bearer initial-access-token");

    settings = {
      ...settings,
      env: {},
      refreshToken: "refresh-token",
      tokenExpiresAt: undefined,
    };
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    connections[0]?.close(1000, "reconnect");
    await waitFor(
      () => connections.length === 2,
      "listener did not reconnect with refreshed credentials",
    );

    expect(authorizations[1]).toBe("Bearer refreshed-access-token");
    expect(settings.refreshToken).toBe("rotated-refresh-token");
  });

  test("transient relay closes preserve turn state queues and approval resolvers", async () => {
    const onDisconnected = mock(() => {});
    const onNeedsReregister = mock(() => {});
    await startClient({ onDisconnected, onNeedsReregister });
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    if (!listener?.transport) {
      throw new Error("listener transport missing after connect");
    }
    const capturedTransport = listener.transport;
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "EXECUTING_CLIENT_SIDE_TOOL",
      executingToolCallIds: ["call-1"],
    });
    conversationRuntime.turnLifecycle.setRunId(turnLease, "run-1");
    conversationRuntime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued follow-up",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof conversationRuntime.queueRuntime.enqueue>[0]);

    const pendingApproval = requestApprovalOverWS(
      conversationRuntime,
      capturedTransport,
      turnLease,
      "perm-1",
      makeControlRequest("perm-1"),
    );
    const approvalResult = pendingApproval.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await waitFor(
      () => conversationRuntime.pendingApprovalResolvers.size === 1,
      "approval resolver was not registered",
    );

    connections[0]?.close(1000, "relay recycle");
    await waitFor(
      () => connections.length === 2,
      "listener did not reconnect after transient close",
    );

    expect(conversationRuntime.turnLifecycle.kind).toBe("active");
    expect(conversationRuntime.loopStatus).toBe("WAITING_ON_APPROVAL");
    expect(conversationRuntime.queueRuntime.length).toBe(1);
    expect(conversationRuntime.pendingApprovalResolvers.size).toBe(1);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onNeedsReregister).not.toHaveBeenCalled();
    await waitFor(
      () => hasPendingApprovalSnapshot(1, "perm-1"),
      "reconnect did not replay pending approval snapshot",
    );

    connections[1]?.send(
      JSON.stringify({
        type: "input",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
        payload: {
          kind: "approval_response",
          request_id: "perm-1",
          decision: { behavior: "allow" },
        },
      }),
    );

    expect(await approvalResult).toMatchObject({
      ok: true,
      value: {
        request_id: "perm-1",
        decision: { behavior: "allow" },
      },
    });
    expect(conversationRuntime.pendingApprovalResolvers.size).toBe(0);

    conversationRuntime.turnLifecycle.finish(turnLease, "end_turn");
    emitLoopStatusUpdate(capturedTransport, conversationRuntime, {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    await waitFor(
      () => hasLoopStatusSnapshot(1, "WAITING_ON_INPUT"),
      "captured turn transport did not emit terminal status on reconnect",
    );
  });

  test("queued input survives a transient relay close behind an active turn", async () => {
    await startClient();
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    if (!listener?.transport) {
      throw new Error("listener transport missing after connect");
    }
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "SENDING_API_REQUEST",
    });
    conversationRuntime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued follow-up",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof conversationRuntime.queueRuntime.enqueue>[0]);

    const queuedItemBeforeClose = conversationRuntime.queueRuntime.peek()[0] as
      | { content?: unknown }
      | undefined;
    expect(queuedItemBeforeClose?.content).toBe("queued follow-up");

    connections[0]?.close(1000, "relay recycle");
    await waitFor(
      () => connections.length === 2,
      "listener did not reconnect after transient close",
    );

    expect(getActiveRuntime()).toBe(listener);
    expect(conversationRuntime.turnLifecycle.kind).toBe("active");
    expect(conversationRuntime.queueRuntime.length).toBe(1);
    const queuedItemAfterReconnect =
      conversationRuntime.queueRuntime.peek()[0] as
        | { content?: unknown }
        | undefined;
    expect(queuedItemAfterReconnect?.content).toBe("queued follow-up");

    conversationRuntime.turnLifecycle.finish(turnLease, "cancelled");
  });

  test("generic split stream close reconnects the paired control socket", async () => {
    const onDisconnected = mock(() => {});
    const onNeedsReregister = mock(() => {});
    await startClient({
      onDisconnected,
      onNeedsReregister,
      supportsSplitStatusChannels: true,
    });
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 1 &&
        countConnectionsForChannel("stream") === 1,
      "initial split sockets did not open",
    );

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    const streamIndex = lastConnectionIndexForChannel("stream");
    connections[streamIndex]?.close(1000, "relay recycle");
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 2 &&
        countConnectionsForChannel("stream") === 2,
      "split stream close did not reconnect paired sockets",
    );

    expect(getActiveRuntime()).toBe(listener);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onNeedsReregister).not.toHaveBeenCalled();
  });

  test("split stream supersession tears down old runtime without reconnecting", async () => {
    const onDisconnected = mock(() => {});
    const onNeedsReregister = mock(() => {});
    await startClient({
      onDisconnected,
      onNeedsReregister,
      supportsSplitStatusChannels: true,
    });
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 1 &&
        countConnectionsForChannel("stream") === 1,
      "initial split sockets did not open",
    );

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    if (!listener?.transport) {
      throw new Error("listener transport missing after connect");
    }
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "WAITING_ON_APPROVAL",
    });
    conversationRuntime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued follow-up",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof conversationRuntime.queueRuntime.enqueue>[0]);
    const pendingApproval = requestApprovalOverWS(
      conversationRuntime,
      listener.transport,
      turnLease,
      "perm-stream-superseded",
      makeControlRequest("perm-stream-superseded"),
    );
    const approvalRejection = pendingApproval.catch((error) => error);
    await waitFor(
      () => conversationRuntime.pendingApprovalResolvers.size === 1,
      "approval resolver was not registered",
    );

    const streamIndex = lastConnectionIndexForChannel("stream");
    connections[streamIndex]?.close(1000, "Replaced by new connection");
    await waitFor(
      () => onDisconnected.mock.calls.length === 1,
      "stream supersession close did not disconnect old runtime",
    );

    const rejection = await approvalRejection;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Listener runtime stopped");
    expect(onNeedsReregister).not.toHaveBeenCalled();
    expect(getActiveRuntime()).toBeNull();
    expect(listener.conversationRuntimes.size).toBe(0);
    expect(conversationRuntime.turnLifecycle.kind).toBe("idle");
    expect(conversationRuntime.queueRuntime.length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countConnectionsForChannel("control")).toBe(1);
    expect(countConnectionsForChannel("stream")).toBe(1);
  });

  test("explicit relay supersession tears down old runtime without reconnecting", async () => {
    const onDisconnected = mock(() => {});
    const onNeedsReregister = mock(() => {});
    await startClient({ onDisconnected, onNeedsReregister });
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    if (!listener?.transport) {
      throw new Error("listener transport missing after connect");
    }
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "WAITING_ON_APPROVAL",
    });
    conversationRuntime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued follow-up",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof conversationRuntime.queueRuntime.enqueue>[0]);
    const pendingApproval = requestApprovalOverWS(
      conversationRuntime,
      listener.transport,
      turnLease,
      "perm-superseded",
      makeControlRequest("perm-superseded"),
    );
    const approvalRejection = pendingApproval.catch((error) => error);
    await waitFor(
      () => conversationRuntime.pendingApprovalResolvers.size === 1,
      "approval resolver was not registered",
    );

    connections[0]?.close(1000, "Replaced by new connection");
    await waitFor(
      () => onDisconnected.mock.calls.length === 1,
      "supersession close did not disconnect old runtime",
    );

    const rejection = await approvalRejection;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Listener runtime stopped");
    expect(onNeedsReregister).not.toHaveBeenCalled();
    expect(getActiveRuntime()).toBeNull();
    expect(listener.conversationRuntimes.size).toBe(0);
    expect(conversationRuntime.turnLifecycle.kind).toBe("idle");
    expect(conversationRuntime.queueRuntime.length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toHaveLength(1);
  });

  test("1008 re-registration closes tear down same-process runtime state", async () => {
    const onNeedsReregister = mock(() => {});
    await startClient({ onNeedsReregister });
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    if (!listener?.transport) {
      throw new Error("listener transport missing after connect");
    }
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "WAITING_ON_APPROVAL",
    });
    conversationRuntime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued follow-up",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof conversationRuntime.queueRuntime.enqueue>[0]);
    const pendingApproval = requestApprovalOverWS(
      conversationRuntime,
      listener.transport,
      turnLease,
      "perm-terminal",
      makeControlRequest("perm-terminal"),
    );
    const approvalRejection = pendingApproval.catch((error) => error);
    await waitFor(
      () => conversationRuntime.pendingApprovalResolvers.size === 1,
      "approval resolver was not registered",
    );

    connections[0]?.close(1008, "environment not found");
    await waitFor(
      () => onNeedsReregister.mock.calls.length === 1,
      "1008 close did not request re-registration",
    );

    const rejection = await approvalRejection;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Listener runtime stopped");
    expect(getActiveRuntime()).toBeNull();
    expect(listener.conversationRuntimes.size).toBe(0);
    expect(connections).toHaveLength(1);
  });

  test("intentional stop closes tear down same-process runtime state", async () => {
    await startClient();
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    if (!listener?.transport) {
      throw new Error("listener transport missing after connect");
    }
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "WAITING_ON_APPROVAL",
    });
    conversationRuntime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued follow-up",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof conversationRuntime.queueRuntime.enqueue>[0]);
    const pendingApproval = requestApprovalOverWS(
      conversationRuntime,
      listener.transport,
      turnLease,
      "perm-stop",
      makeControlRequest("perm-stop"),
    );
    const approvalRejection = pendingApproval.catch((error) => error);
    await waitFor(
      () => conversationRuntime.pendingApprovalResolvers.size === 1,
      "approval resolver was not registered",
    );

    stopListenerClient();

    const rejection = await approvalRejection;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Listener runtime stopped");
    expect(getActiveRuntime()).toBeNull();
    expect(listener.conversationRuntimes.size).toBe(0);
    expect(conversationRuntime.queueRuntime.length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toHaveLength(1);
  });

  test("preserves outbound subscriptions and event sequence across reconnect", async () => {
    await startClient();
    await waitFor(
      () =>
        getActiveRuntime()?.connections.get("connection-id")?.initialized ===
        true,
      "initial listener connection did not initialize",
    );
    const runtime = getActiveRuntime();
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
    const conversationRuntime = getOrCreateScopedRuntime(
      runtime,
      scope.agent_id,
      scope.conversation_id,
    );
    subscribeListenerConnection(runtime, "connection-id", scope);
    emitProtocolV2Message(
      getOrCreateProcessTransport(runtime),
      conversationRuntime,
      { type: "crons_updated", timestamp: 1 } as never,
      scope,
      TO_SUBSCRIBERS,
    );
    await waitFor(
      () =>
        getConnectionMessages(0).some(
          (message) =>
            !!message &&
            typeof message === "object" &&
            (message as { type?: string }).type === "crons_updated",
        ),
      "initial scoped event was not delivered",
    );
    const eventSeqBeforeReconnect =
      runtime.connections.get("connection-id")?.eventSeqCounter ?? 0;

    connections[0]?.close(1000, "reconnect");
    await waitFor(
      () =>
        connections.length === 2 &&
        runtime.connections.get("connection-id")?.initialized === true,
      "listener did not reconnect",
    );

    const reconnected = runtime.connections.get("connection-id");
    expect(reconnected?.subscriptions).toEqual(
      new Set(["agent:agent-1::conversation:conv-1"]),
    );
    expect(reconnected?.eventSeqCounter).toBeGreaterThanOrEqual(
      eventSeqBeforeReconnect,
    );

    emitProtocolV2Message(
      getOrCreateProcessTransport(runtime),
      conversationRuntime,
      { type: "crons_updated", timestamp: 2 } as never,
      scope,
      TO_SUBSCRIBERS,
    );
    await waitFor(
      () =>
        getConnectionMessages(1).some(
          (message) =>
            !!message &&
            typeof message === "object" &&
            (message as { type?: string }).type === "crons_updated",
        ),
      "post-reconnect scoped event was not delivered",
    );
    const resumedEvent = getConnectionMessages(1).find(
      (message) =>
        !!message &&
        typeof message === "object" &&
        (message as { type?: string }).type === "crons_updated",
    ) as { event_seq?: number } | undefined;
    expect(resumedEvent?.event_seq).toBeGreaterThan(eventSeqBeforeReconnect);
  });

  test("does not create a socket after stop wins an in-flight refresh", async () => {
    settings = {
      ...settings,
      env: {},
      refreshToken: "refresh-token",
      tokenExpiresAt: undefined,
    };
    let resolveRefresh: ((tokens: TokenResponse) => void) | undefined;
    refreshAccessTokenMock.mockImplementation(
      () =>
        new Promise<TokenResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const starting = startClient();
    await waitFor(
      () => refreshAccessTokenMock.mock.calls.length === 1,
      "listener did not begin refreshing credentials",
    );

    stopListenerClient();
    resolveRefresh?.({
      access_token: "late-access-token",
      refresh_token: "late-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connections).toHaveLength(0);
  });

  test("retries a transient refresh failure instead of terminating", async () => {
    const onError = mock(() => {});
    await startClient({ onError });
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );

    settings = {
      ...settings,
      env: { LETTA_API_KEY: "expired-access-token" },
      tokenExpiresAt: Date.now() - 1,
    };
    refreshAccessTokenMock
      .mockRejectedValueOnce(
        new OAuthRefreshError("auth service unavailable", {
          retryable: true,
          status: 503,
        }),
      )
      .mockResolvedValueOnce({
        access_token: "recovered-access-token",
        refresh_token: "recovered-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });

    connections[0]?.close(1000, "reconnect");
    await waitFor(
      () => connections.length === 2,
      "listener did not retry the transient refresh failure",
    );

    expect(authorizations[1]).toBe("Bearer recovered-access-token");
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
