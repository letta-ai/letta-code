import { CLEAR_SCREEN_AND_HOME } from "@/cli/app/constants";
import {
  getSystemRemindersVisible,
  setSystemRemindersVisible,
} from "@/cli/components/transcript-display-state";

const USAGE = "Usage: /system-reminders [on|off|status] (default is off)";

export function handleSystemRemindersCommand(args: string[]): string {
  if (args.length === 0) {
    return getSystemRemindersVisible()
      ? "System reminders are shown. Ctrl+R expands or collapses their contents."
      : "System reminders are hidden. Use /system-reminders on to show them.";
  }

  if (args.length !== 1) return USAGE;

  const mode = args[0]?.toLowerCase();
  if (mode === "status") {
    return getSystemRemindersVisible()
      ? "System reminders are shown. Ctrl+R expands or collapses their contents."
      : "System reminders are hidden. Use /system-reminders on to show them.";
  }
  if (mode === "on") {
    if (!getSystemRemindersVisible() && process.stdout?.isTTY) {
      process.stdout.write(CLEAR_SCREEN_AND_HOME);
    }
    setSystemRemindersVisible(true);
    return "System reminders shown. Ctrl+R expands or collapses their contents.";
  }
  if (mode === "off") {
    if (getSystemRemindersVisible() && process.stdout?.isTTY) {
      process.stdout.write(CLEAR_SCREEN_AND_HOME);
    }
    setSystemRemindersVisible(false);
    return "System reminders hidden.";
  }

  return USAGE;
}
