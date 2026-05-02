import { afterEach, describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "../../websocket/listen-client";

const { setActiveRuntime, stopRuntime } = __listenClientTestUtils;

describe("listen reconnect reminders", () => {
  afterEach(() => {
    setActiveRuntime(null);
  });

  test("transport reconnect preserves existing bootstrap reminder and context state", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    setActiveRuntime(runtime);

    const conversationRuntime =
      __listenClientTestUtils.getOrCreateConversationRuntime(
        runtime,
        "agent-1",
        "conv-1",
      );

    conversationRuntime.reminderState.hasSentAgentInfo = true;
    conversationRuntime.reminderState.hasSentSessionContext = true;
    conversationRuntime.reminderState.turnCount = 7;
    conversationRuntime.reminderState.pendingReflectionTrigger = true;
    conversationRuntime.contextTracker.currentTurnId = 9;
    conversationRuntime.contextTracker.pendingReflectionTrigger = true;
    conversationRuntime.contextTracker.pendingCompaction = true;

    const transport = {
      kind: "local" as const,
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };

    try {
      await __listenClientTestUtils.startConnectedListenerRuntime(
        runtime,
        transport,
        {
          connectionId: "connection-1",
          onConnected: () => {},
          onStatusChange: () => {},
          onWsEvent: () => {},
        },
        async () => {},
        { startHeartbeat: false, startCronScheduler: false },
      );

      expect(conversationRuntime.reminderState.hasSentAgentInfo).toBe(true);
      expect(conversationRuntime.reminderState.hasSentSessionContext).toBe(
        true,
      );
      expect(conversationRuntime.reminderState.turnCount).toBe(7);
      expect(conversationRuntime.reminderState.pendingReflectionTrigger).toBe(
        true,
      );
      expect(conversationRuntime.contextTracker.currentTurnId).toBe(9);
      expect(conversationRuntime.contextTracker.pendingReflectionTrigger).toBe(
        true,
      );
      expect(conversationRuntime.contextTracker.pendingCompaction).toBe(true);
    } finally {
      stopRuntime(runtime, true);
      setActiveRuntime(null);
    }
  });
});
