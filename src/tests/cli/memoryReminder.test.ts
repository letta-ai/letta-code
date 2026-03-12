import { afterEach, describe, expect, test } from "bun:test";
import {
  MEMORY_CHECK_REMINDER,
  MEMORY_REFLECTION_REMINDER,
} from "../../agent/promptAssets";
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
  test("prefers local reflection settings over global", () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionTrigger: "compaction-event",
        reflectionBehavior: "auto-launch",
        reflectionStepCount: 33,
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 5,
        reflectionTrigger: "step-count",
        reflectionBehavior: "reminder",
        reflectionStepCount: 25,
      }) as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;

    expect(getReflectionSettings()).toEqual({
      trigger: "compaction-event",
      behavior: "auto-launch",
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
        reflectionBehavior: "reminder",
        reflectionStepCount: 25,
      }) as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;

    expect(getReflectionSettings()).toEqual({
      trigger: "compaction-event",
      behavior: "reminder",
      stepCount: 25,
    });
  });

  test("disables turn-based reminders for non-step-count trigger", async () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionTrigger: "compaction-event",
        reflectionBehavior: "reminder",
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 5,
        reflectionTrigger: "step-count",
        reflectionBehavior: "reminder",
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
        reflectionBehavior: "auto-launch",
        reflectionStepCount: 5,
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: 10,
        reflectionTrigger: "step-count",
        reflectionBehavior: "reminder",
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
        behavior: "reminder",
        stepCount: 25,
      }),
    ).toBeNull();
    expect(
      reflectionSettingsToLegacyMode({
        trigger: "step-count",
        behavior: "auto-launch",
        stepCount: 30,
      }),
    ).toBe(30);
    expect(
      reflectionSettingsToLegacyMode({
        trigger: "compaction-event",
        behavior: "auto-launch",
        stepCount: 25,
      }),
    ).toBe("auto-compaction");
  });

  test("builds compaction reminder with memfs-aware reflection content", async () => {
    (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
      true) as typeof settingsManager.isMemfsEnabled;

    const reminder = await buildCompactionMemoryReminder("agent-1");
    expect(reminder).toBe(MEMORY_REFLECTION_REMINDER);
  });

  test("evaluates step-count trigger based on effective settings", () => {
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "step-count",
        behavior: "auto-launch",
        stepCount: 5,
      }),
    ).toBe(true);
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "step-count",
        behavior: "reminder",
        stepCount: 6,
      }),
    ).toBe(false);
    expect(
      shouldFireStepCountTrigger(10, {
        trigger: "off",
        behavior: "reminder",
        stepCount: 5,
      }),
    ).toBe(false);
  });
});
