import { afterEach, describe, expect, test } from "bun:test";
import { MEMORY_CHECK_REMINDER } from "../../agent/promptAssets";
import {
  buildCompactionMemoryReminder,
  buildMemoryReminder,
  getReflectionSettings,
  reflectionSettingsToLegacyMode,
  shouldFireStepCountTrigger,
} from "../../cli/helpers/memoryReminder";
import { settingsManager } from "../../settings-manager";

const originalGetLocalProjectSettings = settingsManager.getLocalProjectSettings;
const originalGetSettings = settingsManager.getSettings;
const originalIsMemfsEnabled = settingsManager.isMemfsEnabled;

afterEach(() => {
  (settingsManager as typeof settingsManager).getLocalProjectSettings =
    originalGetLocalProjectSettings;
  (settingsManager as typeof settingsManager).getSettings = originalGetSettings;
  (settingsManager as typeof settingsManager).isMemfsEnabled =
    originalIsMemfsEnabled;
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

  test("evaluates step-count trigger based on effective settings", () => {
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "step-count",
        stepCount: 5,
      }),
    ).toBe(true);
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "step-count",
        stepCount: 6,
      }),
    ).toBe(false);
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "off",
        stepCount: 5,
      }),
    ).toBe(false);
  });
});

describe("reflection trigger orchestration", () => {
  const stepProvider = sharedReminderProviders["reflection-step-count"];
  const compactionProvider = sharedReminderProviders["reflection-compaction"];

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
      agent: { id: "test-agent", name: "test" },
      state,
      sessionContextReminderEnabled: false,
      reflectionSettings: {
        trigger: overrides.trigger ?? "step-count",
        stepCount: overrides.stepCount ?? 1,
      },
      skillSources: [],
      resolvePlanModeReminder: async () => "",
      maybeLaunchReflectionSubagent: overrides.callback,
    };
  }

  test("memfs step-count trigger launches reflection callback and returns no reminder", async () => {
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

  test("memfs step-count trigger with no callback does not emit reminder text", async () => {
    const context = buildReflectionContext({
      memfsEnabled: true,
      callback: undefined,
    });

    const reminder = await stepProvider(context);
    expect(reminder).toBeNull();
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

describe("deep-init trigger", () => {
  const deepInitProvider = sharedReminderProviders["deep-init"];

  function makeContext(
    overrides: Partial<{
      shallowInitCompleted: boolean;
      deepInitFired: boolean;
      turnCount: number;
      memfsEnabled: boolean;
      callback: (() => Promise<boolean>) | undefined;
    }> = {},
  ): SharedReminderContext {
    const state = createSharedReminderState();
    state.shallowInitCompleted = overrides.shallowInitCompleted ?? false;
    state.deepInitFired = overrides.deepInitFired ?? false;
    state.turnCount = overrides.turnCount ?? 0;

    const memfsEnabled = overrides.memfsEnabled ?? true;
    (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
      memfsEnabled) as typeof settingsManager.isMemfsEnabled;

    return {
      mode: "interactive",
      agent: { id: "test-agent", name: "test" },
      state,
      sessionContextReminderEnabled: false,
      reflectionSettings: {
        trigger: "step-count",
        stepCount: 25,
      },
      skillSources: [],
      resolvePlanModeReminder: async () => "",
      maybeLaunchDeepInitSubagent: overrides.callback,
    };
  }

  test("does not fire before turn 8", async () => {
    let launched = false;
    const ctx = makeContext({
      shallowInitCompleted: true,
      turnCount: 7,
      callback: async () => {
        launched = true;
        return true;
      },
    });
    const result = await deepInitProvider(ctx);
    expect(result).toBeNull();
    expect(launched).toBe(false);
  });

  // Deep init auto-launch is currently disabled (reflection + deep init
  // at similar turn counts is too chaotic). This test documents the
  // disabled behavior; re-enable when subagent prompts are tuned.
  test("is currently disabled — does not launch even when conditions are met", async () => {
    let launched = false;
    const ctx = makeContext({
      shallowInitCompleted: true,
      turnCount: 8,
      callback: async () => {
        launched = true;
        return true;
      },
    });
    const result = await deepInitProvider(ctx);
    expect(result).toBeNull();
    expect(launched).toBe(false);
  });

  test("does not re-fire once deepInitFired is true", async () => {
    let launched = false;
    const ctx = makeContext({
      shallowInitCompleted: true,
      deepInitFired: true,
      turnCount: 10,
      callback: async () => {
        launched = true;
        return true;
      },
    });
    const result = await deepInitProvider(ctx);
    expect(result).toBeNull();
    expect(launched).toBe(false);
  });

  test("does not fire when shallowInitCompleted is false", async () => {
    let launched = false;
    const ctx = makeContext({
      shallowInitCompleted: false,
      turnCount: 10,
      callback: async () => {
        launched = true;
        return true;
      },
    });
    const result = await deepInitProvider(ctx);
    expect(result).toBeNull();
    expect(launched).toBe(false);
  });

  test("does not fire when memfs is disabled", async () => {
    let launched = false;
    const ctx = makeContext({
      shallowInitCompleted: true,
      turnCount: 8,
      memfsEnabled: false,
      callback: async () => {
        launched = true;
        return true;
      },
    });
    const result = await deepInitProvider(ctx);
    expect(result).toBeNull();
    expect(launched).toBe(false);
  });
});
