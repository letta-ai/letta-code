import { describe, expect, test } from "bun:test";
import {
  buildSharedReminderParts,
  sharedReminderProviders,
} from "../../reminders/engine";
import { buildListenReminderContext } from "../../reminders/listenContext";
import {
  createSharedReminderState,
  resetSharedReminderState,
  type SharedReminderState,
} from "../../reminders/state";

/**
 * Stub providers so tests run in isolation without hitting real
 * session-context or agent-info builders (which touch process.cwd, git, etc.).
 * Stubs mirror the real providers' state mutations so the reminder engine's
 * once-per-session guards work correctly.
 */
function withStubbedProviders(fn: () => Promise<void>): () => Promise<void> {
  const origSession = sharedReminderProviders["session-context"];
  const origAgent = sharedReminderProviders["agent-info"];

  return async () => {
    sharedReminderProviders["session-context"] = async (ctx) => {
      if (
        !ctx.sessionContextReminderEnabled ||
        ctx.state.hasSentSessionContext
      ) {
        return null;
      }
      ctx.state.hasSentSessionContext = true;
      ctx.state.pendingSessionContextReason = undefined;
      return "<session-context-stub>";
    };
    sharedReminderProviders["agent-info"] = async (ctx) => {
      if (ctx.state.hasSentAgentInfo) {
        return null;
      }
      ctx.state.hasSentAgentInfo = true;
      return "<agent-info-stub>";
    };
    try {
      await fn();
    } finally {
      sharedReminderProviders["session-context"] = origSession;
      sharedReminderProviders["agent-info"] = origAgent;
    }
  };
}

function listenContext(
  state: SharedReminderState,
  overrides?: {
    workingDirectory?: string;
    sessionContextReason?: "initial_attach" | "cwd_changed";
  },
) {
  return buildListenReminderContext({
    agentId: "agent-test",
    state,
    reflectionSettings: { trigger: "off", stepCount: 25 },
    resolvePlanModeReminder: () => "",
    ...overrides,
  });
}

describe("listen-mode session context", () => {
  test(
    "first post-attach turn gets session-context and agent-info",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      const ctx = listenContext(state);

      const result = await buildSharedReminderParts(ctx);

      expect(result.appliedReminderIds).toContain("session-context");
      expect(result.appliedReminderIds).toContain("agent-info");
      expect(state.hasSentSessionContext).toBe(true);
      expect(state.hasSentAgentInfo).toBe(true);
    }),
  );

  test(
    "second turn does not re-inject session-context or agent-info",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      const ctx = listenContext(state);

      // First turn — fires
      await buildSharedReminderParts(ctx);

      // Second turn — same state, should NOT re-fire
      const result = await buildSharedReminderParts(ctx);

      expect(result.appliedReminderIds).not.toContain("session-context");
      expect(result.appliedReminderIds).not.toContain("agent-info");
    }),
  );

  test(
    "periodic sync (no state reset) does not re-arm session-context",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      const ctx = listenContext(state);

      // First turn fires
      await buildSharedReminderParts(ctx);
      expect(state.hasSentSessionContext).toBe(true);

      // Simulate periodic sync: DON'T reset state (the fix)
      // Just build again — should not re-inject
      const result = await buildSharedReminderParts(ctx);
      expect(result.appliedReminderIds).not.toContain("session-context");
    }),
  );

  test(
    "WS reconnect (state reset) re-arms session-context on next turn",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      const ctx = listenContext(state);

      // First turn fires
      await buildSharedReminderParts(ctx);
      expect(state.hasSentSessionContext).toBe(true);

      // Simulate WS reconnect: reset state (open handler)
      resetSharedReminderState(state);
      expect(state.hasSentSessionContext).toBe(false);

      // Next turn after reconnect — should fire again
      const result = await buildSharedReminderParts(ctx);
      expect(result.appliedReminderIds).toContain("session-context");
      expect(result.appliedReminderIds).toContain("agent-info");
    }),
  );

  test(
    "CWD change re-arms session-context only, not agent-info",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      const ctx = listenContext(state);

      // First turn fires both
      await buildSharedReminderParts(ctx);
      expect(state.hasSentSessionContext).toBe(true);
      expect(state.hasSentAgentInfo).toBe(true);

      // Simulate CWD change: only invalidate session-context
      state.hasSentSessionContext = false;
      state.pendingSessionContextReason = "cwd_changed";

      const result = await buildSharedReminderParts(ctx);
      expect(result.appliedReminderIds).toContain("session-context");
      expect(result.appliedReminderIds).not.toContain("agent-info");
      // Reason should be cleared after injection
      expect(state.pendingSessionContextReason).toBeUndefined();
    }),
  );

  test(
    "reminder state is per-conversation (separate state objects are independent)",
    withStubbedProviders(async () => {
      const stateA = createSharedReminderState();
      const stateB = createSharedReminderState();

      // Conversation A fires
      const ctxA = listenContext(stateA);
      await buildSharedReminderParts(ctxA);
      expect(stateA.hasSentSessionContext).toBe(true);

      // Conversation B should still fire (fresh state)
      const ctxB = listenContext(stateB);
      const resultB = await buildSharedReminderParts(ctxB);
      expect(resultB.appliedReminderIds).toContain("session-context");

      // A is not affected by B
      expect(stateA.hasSentSessionContext).toBe(true);
    }),
  );

  test("listen mode is included in session-context and agent-info catalog modes", () => {
    const { SHARED_REMINDER_CATALOG } = require("../../reminders/catalog");
    const sessionCtx = SHARED_REMINDER_CATALOG.find(
      (e: { id: string }) => e.id === "session-context",
    );
    const agentInfo = SHARED_REMINDER_CATALOG.find(
      (e: { id: string }) => e.id === "agent-info",
    );
    expect(sessionCtx.modes).toContain("listen");
    expect(agentInfo.modes).toContain("listen");
  });
});
