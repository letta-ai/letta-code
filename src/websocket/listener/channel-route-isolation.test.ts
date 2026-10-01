import { expect, test } from "bun:test";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
} from "@/channels/routing";
import { getLocalChannelTeleportError } from "@/channels/teleport-guard";
import { openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  claimPendingTeleportAtBoundary,
  handleTeleportRequest,
} from "./teleport";

// Deliberately reuse the same identifiers across consecutive tests. The shared
// preload, not a per-suite cleanup or a unique identifier, owns their isolation.
test("a channel route blocks teleport in the test that registers it", () => {
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
  addRoute("telegram", {
    chatId: "12345",
    agentId: "agent-1",
    conversationId: "conv-1",
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  expect(
    getLocalChannelTeleportError({
      agentId: "agent-1",
      conversationId: "conv-1",
    }),
  ).toContain("Teleport is blocked");
});

test("the next test can teleport the same agent and conversation", () => {
  expect(
    getLocalChannelTeleportError({
      agentId: "agent-1",
      conversationId: "conv-1",
    }),
  ).toBeNull();
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  openListenerConnection({
    runtime: listener,
    connectionId: "test-connection",
    writer: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    options: {
      connectionId: "test-connection",
      wsUrl: "wss://example.test",
      deviceId: "device-test",
      connectionName: "test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
  });
  runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  handleTeleportRequest({
    listener,
    connectionId: "test-connection",
    command: {
      type: "teleport_request",
      request_id: "test-request",
      teleport_id: "test-teleport",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    },
  });
  const pending = claimPendingTeleportAtBoundary({
    listener,
    agentId: "agent-1",
    conversationId: "conv-1",
    activeTurn: true,
  });
  expect(pending).not.toBeNull();
  expect(pending?.error).toBeUndefined();
  expect(pending?.activeTurn).toBe(true);
});
