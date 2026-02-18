import { describe, expect, test } from "bun:test";
import type { SharedReminderContext } from "../../reminders/engine";
import { sharedReminderProviders } from "../../reminders/engine";
import { createSharedReminderState } from "../../reminders/state";

function buildContext(): SharedReminderContext {
  return {
    mode: "interactive",
    agent: {
      id: "agent-1",
      name: "Agent 1",
      description: null,
      lastRunAt: null,
    },
    state: createSharedReminderState(),
    sessionContextReminderEnabled: true,
    reflectionSettings: {
      trigger: "off",
      behavior: "reminder",
      stepCount: 25,
    },
    skillSources: ["bundled"],
    resolvePlanModeReminder: () => "",
  };
}

describe("shared skills reminder", () => {
  test("recovers from discovery failure and reinjects after next successful discovery", async () => {
    const provider = sharedReminderProviders.skills;
    const context = buildContext();

    const mutableProcess = process as typeof process & { cwd: () => string };
    const originalCwd = mutableProcess.cwd;
    try {
      mutableProcess.cwd = () => {
        throw new Error("cwd unavailable for test");
      };

      const first = await provider(context);
      expect(first).toBeNull();
      expect(context.state.hasInjectedSkillsReminder).toBe(true);
      expect(context.state.cachedSkillsReminder).toBe("");
    } finally {
      mutableProcess.cwd = originalCwd;
    }

    const second = await provider(context);
    expect(second).not.toBeNull();
    expect(context.state.pendingSkillsReinject).toBe(false);
    if (second) {
      expect(second).toContain("<system-reminder>");
    }
  });
});
