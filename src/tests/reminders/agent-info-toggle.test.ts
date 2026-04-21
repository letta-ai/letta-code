import { describe, expect, test } from "bun:test";
import {
  buildSharedReminderParts,
  type SharedReminderContext,
  sharedReminderProviders,
} from "../../reminders/engine";
import { createSharedReminderState } from "../../reminders/state";

/**
 * Regression test for #1848:
 *
 *   `--no-system-info-reminder` (which maps to
 *   `systemInfoReminderEnabled: false`) must suppress the `agent-info`
 *   reminder too, not just `session-context`. Otherwise embedders that spawn
 *   a fresh subprocess per turn will see the agent-info harness block
 *   prepended on every turn (because `hasSentAgentInfo` resets per process).
 */
function withStubbedReflection(fn: () => Promise<void>): () => Promise<void> {
  const origStep = sharedReminderProviders["reflection-step-count"];
  const origCompaction = sharedReminderProviders["reflection-compaction"];
  const origSession = sharedReminderProviders["session-context"];
  return async () => {
    sharedReminderProviders["reflection-step-count"] = async () => null;
    sharedReminderProviders["reflection-compaction"] = async () => null;
    sharedReminderProviders["session-context"] = async (ctx) => {
      if (!ctx.systemInfoReminderEnabled || ctx.state.hasSentSessionContext) {
        return null;
      }
      ctx.state.hasSentSessionContext = true;
      return "<session-context-stub>";
    };
    try {
      await fn();
    } finally {
      sharedReminderProviders["reflection-step-count"] = origStep;
      sharedReminderProviders["reflection-compaction"] = origCompaction;
      sharedReminderProviders["session-context"] = origSession;
    }
  };
}

function makeCtx(overrides: Partial<SharedReminderContext> = {}) {
  return {
    mode: "headless-one-shot",
    agent: {
      id: "agent-test",
      name: "Test",
      description: null,
      lastRunAt: null,
      conversationId: "conv-test",
    },
    state: createSharedReminderState(),
    systemInfoReminderEnabled: true,
    reflectionSettings: { trigger: "off", stepCount: 25 },
    skillSources: [],
    resolvePlanModeReminder: () => "",
    workingDirectory: "/tmp",
    ...overrides,
  } as SharedReminderContext;
}

describe("agent-info respects systemInfoReminderEnabled flag (#1848)", () => {
  test(
    "agent-info fires when the flag is enabled",
    withStubbedReflection(async () => {
      const ctx = makeCtx({ systemInfoReminderEnabled: true });
      const result = await buildSharedReminderParts(ctx);
      expect(result.appliedReminderIds).toContain("agent-info");
      expect(ctx.state.hasSentAgentInfo).toBe(true);
    }),
  );

  test(
    "agent-info is suppressed when the flag is disabled",
    withStubbedReflection(async () => {
      const ctx = makeCtx({ systemInfoReminderEnabled: false });
      const result = await buildSharedReminderParts(ctx);
      expect(result.appliedReminderIds).not.toContain("agent-info");
      // State is not flipped, so if the flag is later re-enabled the reminder
      // can still fire.
      expect(ctx.state.hasSentAgentInfo).toBe(false);
    }),
  );

  test(
    "session-context is also suppressed when the flag is disabled",
    withStubbedReflection(async () => {
      const ctx = makeCtx({ systemInfoReminderEnabled: false });
      const result = await buildSharedReminderParts(ctx);
      expect(result.appliedReminderIds).not.toContain("session-context");
    }),
  );
});
