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
  const origReflectionStep = sharedReminderProviders["reflection-step-count"];
  const origReflectionCompaction =
    sharedReminderProviders["reflection-compaction"];

  return async () => {
    sharedReminderProviders["session-context"] = async (ctx) => {
      if (!ctx.systemInfoReminderEnabled || ctx.state.hasSentSessionContext) {
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
    // Stub reflection providers to avoid hitting real settingsManager
    sharedReminderProviders["reflection-step-count"] = async () => null;
    sharedReminderProviders["reflection-compaction"] = async () => null;
    try {
      await fn();
    } finally {
      sharedReminderProviders["session-context"] = origSession;
      sharedReminderProviders["agent-info"] = origAgent;
      sharedReminderProviders["reflection-step-count"] = origReflectionStep;
      sharedReminderProviders["reflection-compaction"] =
        origReflectionCompaction;
    }
  };
}

function listenContext(
  state: SharedReminderState,
  overrides?: {
    agentName?: string | null;
    agentDescription?: string | null;
    agentLastRunAt?: string | null;
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

  test("listen mode is included in reflection catalog modes", () => {
    const { SHARED_REMINDER_CATALOG } = require("../../reminders/catalog");
    const stepCount = SHARED_REMINDER_CATALOG.find(
      (e: { id: string }) => e.id === "reflection-step-count",
    );
    const compaction = SHARED_REMINDER_CATALOG.find(
      (e: { id: string }) => e.id === "reflection-compaction",
    );
    expect(stepCount.modes).toContain("listen");
    expect(compaction.modes).toContain("listen");
  });

  test("listen reminder context preserves provided agent metadata", () => {
    const state = createSharedReminderState();
    const ctx = listenContext(state, {
      agentName: "Letta Code",
      agentDescription: "Helpful coding agent",
      agentLastRunAt: "2026-04-01T19:00:00.000Z",
    });

    expect(ctx.agent).toMatchObject({
      id: "agent-test",
      name: "Letta Code",
      description: "Helpful coding agent",
      lastRunAt: "2026-04-01T19:00:00.000Z",
    });
  });
});

describe("listen-mode reflection", () => {
  test(
    "reflection step-count provider fires and invokes launcher at threshold",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      let launchCalled = false;
      let launchSource: string | undefined;

      // Override the reflection-step-count stub with a real-ish implementation
      // that tracks whether the launcher callback is invoked.
      sharedReminderProviders["reflection-step-count"] = async (ctx) => {
        const { shouldFireStepCountTrigger } = await import(
          "../../cli/helpers/memoryReminder"
        );
        if (
          shouldFireStepCountTrigger(
            ctx.state.turnCount,
            ctx.reflectionSettings,
          )
        ) {
          if (ctx.maybeLaunchReflectionSubagent) {
            await ctx.maybeLaunchReflectionSubagent("step-count");
          }
        }
        ctx.state.turnCount += 1;
        return null;
      };

      const ctx = buildListenReminderContext({
        agentId: "agent-test",
        state,
        reflectionSettings: { trigger: "step-count", stepCount: 3 },
        maybeLaunchReflectionSubagent: async (source) => {
          launchCalled = true;
          launchSource = source;
          return true;
        },
        resolvePlanModeReminder: () => "",
      });

      // Turns 0, 1, 2 — should not fire (turnCount 0 is skipped, 1 and 2 are not multiples of 3)
      await buildSharedReminderParts(ctx); // turnCount 0 → 1
      await buildSharedReminderParts(ctx); // turnCount 1 → 2
      await buildSharedReminderParts(ctx); // turnCount 2 → 3
      expect(launchCalled).toBe(false);

      // Turn 3 — turnCount is now 3, which is a multiple of stepCount
      await buildSharedReminderParts(ctx); // turnCount 3 → 4
      expect(launchCalled).toBe(true);
      expect(launchSource).toBe("step-count");
    }),
  );

  test(
    "reflection step-count provider does not fire when trigger is off",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      let launchCalled = false;

      sharedReminderProviders["reflection-step-count"] = async (ctx) => {
        const { shouldFireStepCountTrigger } = await import(
          "../../cli/helpers/memoryReminder"
        );
        if (
          shouldFireStepCountTrigger(
            ctx.state.turnCount,
            ctx.reflectionSettings,
          )
        ) {
          if (ctx.maybeLaunchReflectionSubagent) {
            await ctx.maybeLaunchReflectionSubagent("step-count");
          }
        }
        ctx.state.turnCount += 1;
        return null;
      };

      const ctx = buildListenReminderContext({
        agentId: "agent-test",
        state,
        reflectionSettings: { trigger: "off", stepCount: 1 },
        maybeLaunchReflectionSubagent: async () => {
          launchCalled = true;
          return true;
        },
        resolvePlanModeReminder: () => "",
      });

      // Even with stepCount=1, trigger is off — should never fire
      await buildSharedReminderParts(ctx);
      await buildSharedReminderParts(ctx);
      await buildSharedReminderParts(ctx);
      expect(launchCalled).toBe(false);
    }),
  );
});
