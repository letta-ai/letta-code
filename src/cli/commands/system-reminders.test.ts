import { beforeEach, describe, expect, test } from "bun:test";
import {
  getSystemRemindersExpanded,
  getSystemRemindersVisible,
  setSystemRemindersVisible,
  toggleSystemReminderDisplay,
} from "@/cli/components/transcript-display-state";
import { commands, executeCommand } from "./registry";

describe("/system-reminders", () => {
  beforeEach(() => setSystemRemindersVisible(false));

  test("is discoverable and defaults to hidden", async () => {
    expect(commands["/system-reminders"]).toMatchObject({
      args: "[on|off|status]",
      desc: "Show or hide system reminders",
    });
    expect(getSystemRemindersVisible()).toBe(false);
    expect(await executeCommand("/system-reminders")).toMatchObject({
      success: true,
      output:
        "System reminders are hidden. Use /system-reminders on to show them.",
    });
  });

  test("turns reminder rows on and off", async () => {
    expect(await executeCommand("/system-reminders on")).toMatchObject({
      success: true,
      output:
        "System reminders shown. Ctrl+R expands or collapses their contents.",
    });
    expect(getSystemRemindersVisible()).toBe(true);

    toggleSystemReminderDisplay();
    expect(getSystemRemindersExpanded()).toBe(true);

    expect(await executeCommand("/system-reminders off")).toMatchObject({
      success: true,
      output: "System reminders hidden.",
    });
    expect(getSystemRemindersVisible()).toBe(false);
    expect(getSystemRemindersExpanded()).toBe(false);
  });

  test("rejects unsupported modes", async () => {
    expect(await executeCommand("/system-reminders maybe")).toMatchObject({
      success: true,
      output: "Usage: /system-reminders [on|off|status] (default is off)",
    });
    expect(
      await executeCommand("/system-reminders status extra"),
    ).toMatchObject({
      success: true,
      output: "Usage: /system-reminders [on|off|status] (default is off)",
    });
  });
});
