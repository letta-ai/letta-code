import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { clearAllRoutes } from "@/channels/routing";
import type { ChannelRoute } from "@/channels/types";
import type { WsProtocolCommand } from "@/types/protocol_v2";
import { openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  registerRuntimeExternalTools,
  rejectPendingExternalToolCalls,
} from "./external-tools";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import {
  claimPendingTeleportAtBoundary,
  isRuntimeTeleportPending,
} from "./teleport";
import type { StartListenerOptions } from "./types";

const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
let channelsRoot: string;

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "teleport-channels-"));
  __testOverrideChannelsRoot(channelsRoot);
  clearAllRoutes();
});

afterEach(() => {
  setActiveRuntime(null);
  clearAllRoutes();
  __testOverrideChannelsRoot(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

function persistRoute(channel: string, overrides: Partial<ChannelRoute> = {}) {
  const dir = join(channelsRoot, channel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "routing.yaml"),
    JSON.stringify({
      routes: [
        {
          chatId: "chat-1",
          agentId: scope.agent_id,
          conversationId: scope.conversation_id,
          enabled: true,
          outboundEnabled: true,
          createdAt: "2026-09-04T00:00:00.000Z",
          ...overrides,
        },
      ],
    }),
  );
}

function fixture() {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    isOpen: () => true,
    send: (data: string) => sent.push(JSON.parse(data)),
  };
  const options: StartListenerOptions = {
    connectionId: "source",
    wsUrl: "ws://app-server.test",
    deviceId: "source-device",
    connectionName: "Source",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: listener,
    connectionId: "source",
    writer: socket as unknown as WebSocket,
    options,
  });
  setActiveRuntime(listener);
  const processIncomingMessage = mock(async () => {});
  const runDetachedListenerTask = mock(() => {});
  const handle = createListenerMessageHandler({
    runtime: listener,
    socket: socket as unknown as WebSocket,
    opts: options,
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => runtime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: (_target, payload) => {
      sent.push(payload);
      return true;
    },
    runDetachedListenerTask,
    trackListenerError: () => {},
    processIncomingMessage,
  });
  const deliver = (command: WsProtocolCommand) =>
    handle(Buffer.from(JSON.stringify(command)));
  const request = (teleportId = "teleport-1") =>
    deliver({
      type: "teleport_request",
      request_id: teleportId,
      teleport_id: teleportId,
      runtime: scope,
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    });
  return {
    listener,
    runtime,
    sent,
    deliver,
    request,
    processIncomingMessage,
    runDetachedListenerTask,
  };
}

test.each(["telegram", "slack", "discord"])(
  "rejects a wire request for a local %s route without yielding or restarting the source",
  async (channel) => {
    persistRoute(channel);
    const f = fixture();
    const lease = f.runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });

    await f.request();
    await f.request(); // A repeated rejection must not become a pending handoff.
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        success: false,
        active_turn: false,
        error: expect.stringContaining(`bound to ${channel}`),
      }),
    );
    expect(
      isRuntimeTeleportPending(
        f.listener,
        scope.agent_id,
        scope.conversation_id,
      ),
    ).toBe(false);
    expect(
      claimPendingTeleportAtBoundary({
        listener: f.listener,
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
        activeTurn: true,
      }),
    ).toBeNull();
    expect(f.runtime.turnLifecycle.isCurrent(lease)).toBe(true);
    expect(f.runtime.isProcessing).toBe(true);

    await f.deliver({
      type: "teleport_failed",
      teleport_id: "teleport-1",
      runtime: scope,
      error: "Local channel teleport is blocked",
    });
    expect(f.runDetachedListenerTask).not.toHaveBeenCalled();
    expect(f.processIncomingMessage).not.toHaveBeenCalled();
    expect(f.runtime.turnLifecycle.isCurrent(lease)).toBe(true);
    f.runtime.turnLifecycle.finish(lease, "end_turn");
  },
);

test.each([
  { enabled: false },
  { outboundEnabled: false },
  { agentId: "another-agent" },
  { conversationId: "another-conversation" },
])("ignores an unrelated or inactive local route: %j", async (overrides) => {
  persistRoute("telegram", overrides);
  const f = fixture();
  await f.request();
  expect(f.sent).toContainEqual(
    expect.objectContaining({ type: "teleport_ready", success: true }),
  );
});

test("a Cloud-managed MessageChannel registration alone does not block teleport", async () => {
  const f = fixture();
  registerRuntimeExternalTools(f.listener, "source", scope, [
    {
      tools: [
        {
          name: "MessageChannel",
          description: "Cloud channel replies",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
  ]);
  try {
    await f.request();
    expect(f.sent).toContainEqual(
      expect.objectContaining({ type: "teleport_ready", success: true }),
    );
  } finally {
    rejectPendingExternalToolCalls(f.listener, "test cleanup");
  }
});

test("removing a route in the gateway process unblocks the next request", async () => {
  persistRoute("telegram");
  const f = fixture();
  await f.request();
  expect(f.sent).toContainEqual(
    expect.objectContaining({ type: "teleport_ready", success: false }),
  );

  // The gateway writes the file in a different process, so it cannot clear
  // any routes cached in this listener.
  writeFileSync(
    join(channelsRoot, "telegram", "routing.yaml"),
    JSON.stringify({ routes: [] }),
  );
  f.sent.length = 0;
  await f.request();
  expect(f.sent).toContainEqual(
    expect.objectContaining({ type: "teleport_ready", success: false }),
  );
  f.sent.length = 0;
  await f.request("teleport-2");
  expect(f.sent).toContainEqual(
    expect.objectContaining({ type: "teleport_ready", success: true }),
  );
});
