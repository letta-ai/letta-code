import { afterEach, describe, expect, test } from "bun:test";
import {
  MEMORY_CHECK_REMINDER,
  MEMORY_REFLECTION_REMINDER,
} from "../../agent/promptAssets";
import {
  buildCompactionMemoryReminder,
  buildMemoryReminder,
  getMemoryReminderMode,
} from "../../cli/helpers/memoryReminder";
import { settingsManager } from "../../settings-manager";

const originalGetLocalProjectSettings = settingsManager.getLocalProjectSettings;
const originalGetSetting = settingsManager.getSetting;
const originalIsMemfsEnabled = settingsManager.isMemfsEnabled;

afterEach(() => {
  (settingsManager as typeof settingsManager).getLocalProjectSettings =
    originalGetLocalProjectSettings;
  (settingsManager as typeof settingsManager).getSetting = originalGetSetting;
  (settingsManager as typeof settingsManager).isMemfsEnabled =
    originalIsMemfsEnabled;
});

describe("memoryReminder", () => {
  test("prefers local project memory reminder mode over global", () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        memoryReminderInterval: "compaction",
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSetting = (() =>
      5) as typeof settingsManager.getSetting;

    expect(getMemoryReminderMode()).toBe("compaction");
  });

  test("disables turn-based reminders for compaction mode", async () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        memoryReminderInterval: "compaction",
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSetting = (() =>
      5) as typeof settingsManager.getSetting;

    const reminder = await buildMemoryReminder(10, "agent-1");
    expect(reminder).toBe("");
  });

  test("keeps existing numeric interval behavior", async () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        memoryReminderInterval: 5,
      }) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    (settingsManager as typeof settingsManager).getSetting = (() =>
      5) as typeof settingsManager.getSetting;
    (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
      false) as typeof settingsManager.isMemfsEnabled;

    const reminder = await buildMemoryReminder(10, "agent-1");
    expect(reminder).toBe(MEMORY_CHECK_REMINDER);
  });

  test("builds compaction reminder with memfs-aware reflection content", async () => {
    (settingsManager as typeof settingsManager).isMemfsEnabled = (() =>
      true) as typeof settingsManager.isMemfsEnabled;

    const reminder = await buildCompactionMemoryReminder("agent-1");
    expect(reminder).toBe(MEMORY_REFLECTION_REMINDER);
  });
});
