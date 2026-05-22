import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_CHECK_REMINDER } from "@/agent/prompt-assets";
import {
  buildCompactionMemoryReminder,
  buildMemoryReminder,
  getReflectionSettings,
  persistReflectionSettingsForAgent,
  reflectionSettingsToLegacyMode,
  shouldFireStepCountTrigger,
} from "@/cli/helpers/memory-reminder";
import { appendTranscriptDeltaJsonl } from "@/cli/helpers/reflection-transcript";
import {
  type SharedReminderContext,
  sharedReminderProviders,
} from "@/reminders/engine";
import { createSharedReminderState } from "@/reminders/state";
import { settingsManager } from "@/settings-manager";

const originalGetLocalProjectSettings = settingsManager.getLocalProjectSettings;
const originalGetSettings = settingsManager.getSettings;
const originalIsMemfsEnabled = settingsManager.isMemfsEnabled;
const originalLoadLocalProjectSettings =
  settingsManager.loadLocalProjectSettings;
const originalUpdateLocalProjectSettings =
  settingsManager.updateLocalProjectSettings;
const originalUpdateSettings = settingsManager.updateSettings;
const originalTranscriptRoot = process.env.LETTA_TRANSCRIPT_ROOT;

afterEach(() => {
  (settingsManager as typeof settingsManager).getLocalProjectSettings =
    originalGetLocalProjectSettings;
  (settingsManager as typeof settingsManager).getSettings = originalGetSettings;
  (settingsManager as typeof settingsManager).isMemfsEnabled =
    originalIsMemfsEnabled;
  (settingsManager as typeof settingsManager).loadLocalProjectSettings =
    originalLoadLocalProjectSettings;
  (settingsManager as typeof settingsManager).updateLocalProjectSettings =
    originalUpdateLocalProjectSettings;
  (settingsManager as typeof settingsManager).updateSettings =
    originalUpdateSettings;
  if (originalTranscriptRoot === undefined) {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
  } else {
    process.env.LETTA_TRANSCRIPT_ROOT = originalTranscriptRoot;
  }
});

describe("memoryReminder", () => {
  test("prefers local reflection settings over global and ignores legacy behavior field", () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionTrigger: "compaction-event",
        reflectionStepCount: 33,
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 5,
        reflectionTrigger: "step-count",
        // Legacy key from older settings files should be ignored safely.
        reflectionBehavior: "reminder",
        reflectionStepCount: 25,
      }) as unknown as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;

    expect(getReflectionSettings()).toEqual({
      trigger: "compaction-event",
      stepCount: 33,
    });
  });

  test("falls back to legacy local mode when split fields are absent", () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        memoryReminderInterval: "compaction",
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 5,
        reflectionTrigger: "step-count",
        reflectionStepCount: 25,
      }) as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;

    expect(getReflectionSettings()).toEqual({
      trigger: "compaction-event",
      stepCount: 25,
    });
  });

  test("prefers local per-agent settings over global per-agent settings", () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionSettingsByAgent: {
          "agent-1": {
            trigger: "compaction-event",
            stepCount: 13,
          },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getLocalProjectSettings
      >;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        reflectionSettingsByAgent: {
          "agent-1": {
            trigger: "step-count",
            stepCount: 9,
          },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;

    expect(getReflectionSettings("agent-1")).toEqual({
      trigger: "compaction-event",
      stepCount: 13,
    });
  });

  test("falls back to per-agent global settings before legacy settings", () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionTrigger: "off",
        reflectionStepCount: 100,
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 5,
        reflectionTrigger: "step-count",
        reflectionStepCount: 25,
        reflectionSettingsByAgent: {
          "agent-1": {
            trigger: "compaction-event",
            stepCount: 17,
          },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;

    expect(getReflectionSettings("agent-1")).toEqual({
      trigger: "compaction-event",
      stepCount: 17,
    });
  });

  test("disables turn-based reminders for non-step-count trigger", async () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionTrigger: "compaction-event",
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 5,
        reflectionTrigger: "step-count",
        reflectionStepCount: 25,
      }) as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;

    const reminder = await buildMemoryReminder(10, "agent-1");
    expect(reminder).toBe("");
  });

  test("keeps existing numeric interval behavior", async () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionTrigger: "step-count",
        reflectionStepCount: 5,
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 10,
        reflectionTrigger: "step-count",
        reflectionStepCount: 25,
      }) as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;
    (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
      false) as typeof settingsManager.isMemfsEnabled;

    const reminder = await buildMemoryReminder(10, "agent-1");
    expect(reminder).toBe(MEMORY_CHECK_REMINDER);
  });

  test("maps split reflection settings back to legacy mode", () => {
    expect(
      reflectionSettingsToLegacyMode({
        trigger: "off",
        stepCount: 25,
      }),
    ).toBeNull();
    expect(
      reflectionSettingsToLegacyMode({
        trigger: "step-count",
        stepCount: 30,
      }),
    ).toBe(30);
    expect(
      reflectionSettingsToLegacyMode({
        trigger: "compaction-event",
        stepCount: 25,
      }),
    ).toBe("auto-compaction");
  });

  test("builds compaction reminder using memory-check content", async () => {
    (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
      true) as typeof settingsManager.isMemfsEnabled;

    const reminder = await buildCompactionMemoryReminder("agent-1");
    expect(reminder).toBe(MEMORY_CHECK_REMINDER);
  });

  test("evaluates step-count trigger from turns since successful reflection", () => {
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "step-count",
        stepCount: 5,
      }),
    ).toBe(true);
    expect(
      shouldFireStepCountTrigger(4, {
        trigger: "step-count",
        stepCount: 5,
      }),
    ).toBe(false);
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "off",
        stepCount: 5,
      }),
    ).toBe(false);
  });

  test("persistReflectionSettingsForAgent writes scoped settings to local and global stores", async () => {
    const localUpdates: Array<Record<string, unknown>> = [];
    const globalUpdates: Array<Record<string, unknown>> = [];

    (settingsManager as typeof settingsManager).getLocalProjectSettings = (() =>
      ({
        reflectionSettingsByAgent: {
          "agent-2": {
            trigger: "off",
            stepCount: 5,
          },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getLocalProjectSettings
      >) as typeof settingsManager.getLocalProjectSettings;
    (settingsManager as typeof settingsManager).loadLocalProjectSettings =
      (async () =>
        ({}) as ReturnType<
          typeof settingsManager.getLocalProjectSettings
        >) as typeof settingsManager.loadLocalProjectSettings;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        reflectionSettingsByAgent: {
          "agent-3": {
            trigger: "off",
            stepCount: 7,
          },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;
    (settingsManager as typeof settingsManager).updateLocalProjectSettings = ((
      updates,
    ) => {
      localUpdates.push(updates as Record<string, unknown>);
    }) as typeof settingsManager.updateLocalProjectSettings;
    (settingsManager as typeof settingsManager).updateSettings = ((updates) => {
      globalUpdates.push(updates as Record<string, unknown>);
    }) as typeof settingsManager.updateSettings;

    await persistReflectionSettingsForAgent("agent-1", {
      trigger: "compaction-event",
      stepCount: 11,
    });

    expect(localUpdates).toHaveLength(1);
    expect(globalUpdates).toHaveLength(1);
    expect(localUpdates[0]?.reflectionSettingsByAgent).toEqual({
      "agent-2": { trigger: "off", stepCount: 5 },
      "agent-1": { trigger: "compaction-event", stepCount: 11 },
    });
    expect(globalUpdates[0]?.reflectionSettingsByAgent).toEqual({
      "agent-3": { trigger: "off", stepCount: 7 },
      "agent-1": { trigger: "compaction-event", stepCount: 11 },
    });
  });
});

describe("reflection trigger orchestration", () => {
  const stepProvider = sharedReminderProviders["reflection-step-count"];
  const compactionProvider = sharedReminderProviders["reflection-compaction"];
  const orchestrationAgentId = "test-agent";
  const orchestrationConversationId = "test-conversation";

  async function withTranscriptRoot<T>(fn: () => Promise<T>): Promise<T> {
    const testRoot = await mkdtemp(join(tmpdir(), "letta-reminder-test-"));
    const previousRoot = process.env.LETTA_TRANSCRIPT_ROOT;
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
    try {
      return await fn();
    } finally {
      if (previousRoot === undefined) {
        delete process.env.LETTA_TRANSCRIPT_ROOT;
      } else {
        process.env.LETTA_TRANSCRIPT_ROOT = previousRoot;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  }

  async function appendCompletedTurns(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await appendTranscriptDeltaJsonl(
        orchestrationAgentId,
        orchestrationConversationId,
        [
          {
            kind: "user",
            id: `u${index}`,
            text: `turn ${index}`,
            messageId: `msg-u${index}`,
          },
          {
            kind: "assistant",
            id: `a${index}`,
            text: `response ${index}`,
            phase: "finished",
            messageId: `msg-a${index}`,
          },
        ],
      );
    }
  }

  function buildReflectionContext(
    overrides: Partial<{
      trigger: "off" | "step-count" | "compaction-event";
      stepCount: number;
      turnCount: number;
      memfsEnabled: boolean;
      callback:
        | ((trigger: "step-count" | "compaction-event") => Promise<boolean>)
        | undefined;
      pendingReflectionTrigger: boolean;
    }> = {},
  ): SharedReminderContext {
    const state = createSharedReminderState();
    state.turnCount = overrides.turnCount ?? 1;
    state.pendingReflectionTrigger =
      overrides.pendingReflectionTrigger ?? false;

    (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
      overrides.memfsEnabled ?? true) as typeof settingsManager.isMemfsEnabled;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 25,
        reflectionTrigger: overrides.trigger ?? "step-count",
        reflectionStepCount: overrides.stepCount ?? 1,
      }) as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionTrigger: overrides.trigger ?? "step-count",
        reflectionStepCount: overrides.stepCount ?? 1,
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;

    return {
      mode: "interactive",
      agent: {
        id: orchestrationAgentId,
        name: "test",
        conversationId: orchestrationConversationId,
      },
      state,
      systemInfoReminderEnabled: false,
      reflectionSettings: {
        trigger: overrides.trigger ?? "step-count",
        stepCount: overrides.stepCount ?? 1,
      },
      skillSources: [],
      maybeLaunchReflectionSubagent: overrides.callback,
    };
  }

  test("memfs step-count trigger launches reflection callback and returns no reminder", async () => {
    await withTranscriptRoot(async () => {
      await appendCompletedTurns(1);
      const launches: Array<"step-count" | "compaction-event"> = [];
      const context = buildReflectionContext({
        memfsEnabled: true,
        callback: async (trigger) => {
          launches.push(trigger);
          return true;
        },
      });

      const reminder = await stepProvider(context);
      expect(reminder).toBeNull();
      expect(launches).toEqual(["step-count"]);
    });
  });

  test("memfs step-count trigger with no callback does not emit reminder text", async () => {
    await withTranscriptRoot(async () => {
      await appendCompletedTurns(1);
      const context = buildReflectionContext({
        memfsEnabled: true,
        callback: undefined,
      });

      const reminder = await stepProvider(context);
      expect(reminder).toBeNull();
    });
  });

  test("memfs step-count trigger uses transcript counter instead of reminder turn count", async () => {
    await withTranscriptRoot(async () => {
      const launches: Array<"step-count" | "compaction-event"> = [];
      const context = buildReflectionContext({
        turnCount: 100,
        stepCount: 2,
        memfsEnabled: true,
        callback: async (trigger) => {
          launches.push(trigger);
          return true;
        },
      });

      await stepProvider(context);
      expect(launches).toEqual([]);

      await appendCompletedTurns(2);
      await stepProvider(context);
      expect(launches).toEqual(["step-count"]);
    });
  });

  test("non-memfs step-count trigger falls back to memory-check reminder", async () => {
    const context = buildReflectionContext({
      memfsEnabled: false,
      callback: undefined,
    });

    const reminder = await stepProvider(context);
    expect(reminder).toBe(MEMORY_CHECK_REMINDER);
  });

  test("memfs compaction trigger with no callback emits no reminder", async () => {
    const context = buildReflectionContext({
      trigger: "compaction-event",
      memfsEnabled: true,
      callback: undefined,
      pendingReflectionTrigger: true,
    });

    const reminder = await compactionProvider(context);
    expect(reminder).toBeNull();
  });
});
