import { runNotificationHooks } from "@/hooks";
import { debugLog } from "@/utils/debug";

export function sendDesktopNotification(
  message = "Awaiting your input",
  level: "info" | "warning" | "error" = "info",
) {
  process.stdout.write("\x07");
  runNotificationHooks(message, level).catch((error) => {
    debugLog("hooks", "Notification hook error", error);
  });
}
