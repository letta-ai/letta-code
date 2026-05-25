import { runNotificationHooks } from "@/hooks";
import { debugLog } from "@/utils/debug";

// Send desktop notification via terminal bell
// Modern terminals (iTerm2, Ghostty, WezTerm, Kitty) convert this to a desktop
// notification when the terminal is not focused
export function sendDesktopNotification(
  message = "Awaiting your input",
  level: "info" | "warning" | "error" = "info",
) {
  // Send terminal bell for native notification
  process.stdout.write("\x07");
  // Run Notification hooks (fire-and-forget, don't block)
  runNotificationHooks(message, level).catch((error) => {
    debugLog("hooks", "Notification hook error", error);
  });
}
