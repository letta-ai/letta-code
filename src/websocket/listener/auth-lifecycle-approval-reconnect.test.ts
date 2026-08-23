import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { ApprovalResult } from "@/agent/approval-execution";
import type { TokenResponse } from "@/auth/oauth";
import type { ChannelTurnSource } from "@/channels/types";
import { settingsManager } from "@/settings-manager";
import { getToolSchema } from "@/tools/manager";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import { __listenerAuthTestUtils } from "@/websocket/listener/auth";
import { subscribeListenerConnection } from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { getOrCreateConversationPermissionModeStateRef } from "@/websocket/listener/permission-mode";
import { finalizeHandledRecoveryTurn } from "@/websocket/listener/recovery";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import { isListenerTransportOpen } from "@/websocket/listener/transport";
import { handleApprovalStop } from "@/websocket/listener/turn-approval";
import { createTurnInputState } from "@/websocket/listener/turn-input-state";

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

type Approval = {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("listener approval reconnect timing", () => {
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
  let messagesByConnection: WeakMap<WebSocket, unknown[]>;

  const refreshAccessTokenMock = mock(async (): Promise<TokenResponse> => {
    throw new Error("refreshAccessToken not mocked");
  });

  beforeEach(async () => {
    stopListenerClient();
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-listener-approval-"));
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
    messagesByConnection = new WeakMap();
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}`;
    server.on("connection", (socket, request) => {
      connections.push(socket);
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      connectionChannels.push(requestUrl.searchParams.get("channel"));
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

  function startClient() {
    return startListenerClient({
      connectionId: "connection-id",
      wsUrl,
      supportsSplitStatusChannels: true,
      deviceId: "device-id",
      connectionName: "listener-name",
      onConnected: mock(() => {}),
      onDisconnected: mock(() => {}),
      onNeedsReregister: mock(() => {}),
      onError: mock(() => {}),
    });
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
    return socket ? (messagesByConnection.get(socket) ?? []) : [];
  }

  function countToolStreamDeltas(messageType: string, toolCallId: string) {
    let count = 0;
    for (let index = 0; index < connections.length; index += 1) {
      for (const message of getConnectionMessages(index)) {
        const candidate = message as {
          type?: string;
          delta?: {
            message_type?: string;
            tool_call_id?: string;
            tool_returns?: Array<{ tool_call_id?: string }>;
          };
        };
        if (
          candidate?.type === "stream_delta" &&
          candidate.delta?.message_type === messageType &&
          (candidate.delta.tool_call_id === toolCallId ||
            candidate.delta.tool_returns?.some(
              (toolReturn) => toolReturn.tool_call_id === toolCallId,
            ) === true)
        ) {
          count += 1;
        }
      }
    }
    return count;
  }

  function makeAutoAllowedDeps(
    approval: Approval,
    turnLease: { signal: AbortSignal },
    _turnSources: ChannelTurnSource[],
    executionResults: ApprovalResult[],
  ) {
    return {
      classifyApprovals: mock(async (receivedApprovals: Approval[]) => {
        expect(receivedApprovals).toEqual([approval]);
        return {
          needsUserInput: [],
          autoDenied: [],
          autoAllowed: [
            {
              approval,
              permission: { decision: "allow" },
              context: null,
              parsedArgs: { command: "pwd" },
            },
          ],
        };
      }),
      executeApprovalBatch: mock(
        async (
          decisions: Array<{ type: string; approval: Approval }>,
          _toolContext: unknown,
          options: {
            abortSignal?: AbortSignal;
            workingDirectory?: string;
            parentScope?: { agentId?: string; conversationId?: string };
          },
        ) => {
          expect(decisions).toEqual([{ type: "approve", approval }]);
          expect(options.abortSignal).toBe(turnLease.signal);
          expect(options.workingDirectory).toBe(process.cwd());
          expect(options.parentScope).toEqual({
            agentId: "agent-1",
            conversationId: "conv-1",
          });
          return executionResults;
        },
      ),
      ensureSecretsHydrated: mock(async () => {}),
      sendApprovalContinuation: mock(async () => ({
        kind: "terminal" as const,
        drainResult: { stopReason: "end_turn" as const, apiDurationMs: 0 },
      })),
    };
  }

  test("disconnected requires_approval producer waits for reconnect before executing a generic client tool", async () => {
    await startClient();
    await waitFor(
      () =>
        getActiveRuntime()?.connections.get("connection-id")?.initialized ===
        true,
      "initial listener connection did not initialize",
    );

    const listener = getActiveRuntime();
    expect(listener?.transport).toBeTruthy();
    if (!listener?.transport) throw new Error("listener transport missing");
    subscribeListenerConnection(listener, "connection-id", {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    const capturedTransport = listener.transport;
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "PROCESSING_API_RESPONSE",
    });
    conversationRuntime.turnLifecycle.setRunId(turnLease, "run-disconnected");

    let resolveRefresh: ((tokens: TokenResponse) => void) | undefined;
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "expired-access-token" },
      tokenExpiresAt: Date.now() - 1,
    };
    refreshAccessTokenMock.mockImplementation(
      () =>
        new Promise<TokenResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const initialControlIndex = lastConnectionIndexForChannel("control");
    connections[initialControlIndex]?.close(1000, "relay recycle");
    await waitFor(
      () =>
        refreshAccessTokenMock.mock.calls.length === 1 &&
        listener.socket === null &&
        !isListenerTransportOpen(capturedTransport),
      "listener did not enter disconnected reconnect state",
    );

    const genericClientToolName = "GenericDelayedReconnectClientTool";
    expect(getToolSchema(genericClientToolName)).toBeUndefined();
    const approval = {
      toolCallId: "call-while-disconnected",
      toolName: genericClientToolName,
      toolArgs: JSON.stringify({ command: "pwd" }),
    };
    const executionResults = [
      {
        type: "tool" as const,
        tool_call_id: approval.toolCallId,
        status: "success" as const,
        tool_return: "client-tool-output",
      },
    ] satisfies ApprovalResult[];
    const deps = makeAutoAllowedDeps(approval, turnLease, [], executionResults);

    const approvalStop = handleApprovalStop({
      approvals: [approval],
      runtime: conversationRuntime,
      socket: capturedTransport,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: process.cwd(),
      turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
        listener,
        "agent-1",
        "conv-1",
      ),
      dequeuedBatchId: "batch-disconnected",
      runId: "run-disconnected",
      msgRunIds: ["run-disconnected"],
      turnInput: createTurnInputState([]),
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      turnLease,
      buildSendOptions: () => ({ streamTokens: true }),
      dependencies: deps as never,
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(conversationRuntime.loopStatus).toBe("PROCESSING_API_RESPONSE");
    expect(deps.executeApprovalBatch).toHaveBeenCalledTimes(0);
    expect(deps.ensureSecretsHydrated).toHaveBeenCalledTimes(0);
    expect(deps.sendApprovalContinuation).toHaveBeenCalledTimes(0);
    expect(
      countToolStreamDeltas("client_tool_start", approval.toolCallId),
    ).toBe(0);

    resolveRefresh?.({
      access_token: "reconnected-access-token",
      refresh_token: "reconnected-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 2 &&
        countConnectionsForChannel("stream") === 2,
      "listener did not reconnect control and stream sockets",
    );

    const result = await approvalStop;
    expect(result.kind).toBe("terminal");
    if (result.kind !== "terminal") {
      throw new Error("approval continuation did not finish terminally");
    }
    const transition = finalizeHandledRecoveryTurn(
      conversationRuntime,
      capturedTransport,
      turnLease,
      {
        drainResult: result.drainResult,
        agentId: "agent-1",
        conversationId: "conv-1",
        turnId: "run-disconnected",
      },
    );
    expect(transition.finished).toBe(true);
    expect(deps.executeApprovalBatch).toHaveBeenCalledTimes(1);
    expect(deps.ensureSecretsHydrated).toHaveBeenCalledTimes(1);
    expect(deps.sendApprovalContinuation).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        countToolStreamDeltas("client_tool_start", approval.toolCallId) === 1 &&
        countToolStreamDeltas("client_tool_end", approval.toolCallId) === 1 &&
        countToolStreamDeltas("tool_return_message", approval.toolCallId) === 1,
      "client tool lifecycle/result messages were not emitted exactly once",
    );
    expect(
      countToolStreamDeltas("client_tool_start", approval.toolCallId),
    ).toBe(1);
    expect(countToolStreamDeltas("client_tool_end", approval.toolCallId)).toBe(
      1,
    );
    expect(
      countToolStreamDeltas("tool_return_message", approval.toolCallId),
    ).toBe(1);
    expect(conversationRuntime.turnLifecycle.kind).toBe("idle");
    expect(conversationRuntime.lastStopReason).toBe("end_turn");
  });

  test("disconnected client-tool approval waits until listener stop interrupts execution", async () => {
    await startClient();
    await waitFor(
      () =>
        getActiveRuntime()?.connections.get("connection-id")?.initialized ===
        true,
      "initial listener connection did not initialize",
    );

    const listener = getActiveRuntime();
    expect(listener?.transport).toBeTruthy();
    if (!listener?.transport) throw new Error("listener transport missing");
    const capturedTransport = listener.transport;
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "PROCESSING_API_RESPONSE",
    });

    let resolveRefresh: ((tokens: TokenResponse) => void) | undefined;
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "expired-access-token" },
      tokenExpiresAt: Date.now() - 1,
    };
    refreshAccessTokenMock.mockImplementation(
      () =>
        new Promise<TokenResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const initialControlIndex = lastConnectionIndexForChannel("control");
    connections[initialControlIndex]?.close(1000, "relay recycle");
    await waitFor(
      () =>
        refreshAccessTokenMock.mock.calls.length === 1 &&
        listener.socket === null &&
        !isListenerTransportOpen(capturedTransport),
      "listener did not enter disconnected reconnect state",
    );

    const approval = {
      toolCallId: "call-stop-while-disconnected",
      toolName: "GenericStopWhileDisconnectedClientTool",
      toolArgs: JSON.stringify({ command: "pwd" }),
    };
    const deps = makeAutoAllowedDeps(approval, turnLease, [], []);
    const approvalStop = handleApprovalStop({
      approvals: [approval],
      runtime: conversationRuntime,
      socket: capturedTransport,
      agentId: "agent-1",
      conversationId: "conv-1",
      turnWorkingDirectory: process.cwd(),
      turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
        listener,
        "agent-1",
        "conv-1",
      ),
      dequeuedBatchId: "batch-stop-disconnected",
      runId: "run-stop-disconnected",
      msgRunIds: ["run-stop-disconnected"],
      turnInput: createTurnInputState([]),
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId: null,
      turnLease,
      buildSendOptions: () => ({ streamTokens: true }),
      dependencies: deps as never,
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(deps.executeApprovalBatch).toHaveBeenCalledTimes(0);
    expect(deps.ensureSecretsHydrated).toHaveBeenCalledTimes(0);
    expect(deps.sendApprovalContinuation).toHaveBeenCalledTimes(0);
    stopListenerClient();
    resolveRefresh?.({
      access_token: "late-access-token",
      refresh_token: "late-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const result = await approvalStop;
    expect(result.kind).toBe("interrupted");
    if (result.kind !== "interrupted") {
      throw new Error("listener stop did not interrupt disconnected approval");
    }
    expect(deps.executeApprovalBatch).toHaveBeenCalledTimes(0);
    expect(deps.ensureSecretsHydrated).toHaveBeenCalledTimes(0);
    expect(deps.sendApprovalContinuation).toHaveBeenCalledTimes(0);
    expect(
      countToolStreamDeltas("client_tool_start", approval.toolCallId),
    ).toBe(0);
  });
});
