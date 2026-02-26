export type ReasoningTabToggleResolution =
  | { kind: "status"; message: string }
  | { kind: "set"; enabled: boolean; message: string }
  | { kind: "invalid"; message: string };

const ENABLE_ARGS = new Set(["on", "enable", "enabled", "true", "1"]);
const DISABLE_ARGS = new Set(["off", "disable", "disabled", "false", "0"]);

const USAGE = "Usage: /reasoning-tab [on|off|status] (default is off)";

export function resolveReasoningTabToggleCommand(
  trimmedInput: string,
  currentlyEnabled: boolean,
): ReasoningTabToggleResolution | null {
  const trimmed = trimmedInput.trim();
  if (
    trimmed !== "/reasoning-tab" &&
    !trimmed.startsWith("/reasoning-tab ")
  ) {
    return null;
  }

  const rawArg = trimmed.slice("/reasoning-tab".length).trim().toLowerCase();
  if (!rawArg || rawArg === "status") {
    return {
      kind: "status",
      message: currentlyEnabled
        ? "Reasoning Tab shortcut is enabled. Tab now cycles reasoning tiers."
        : "Reasoning Tab shortcut is disabled. Use /reasoning-tab on to enable it.",
    };
  }

  if (ENABLE_ARGS.has(rawArg)) {
    return {
      kind: "set",
      enabled: true,
      message: "Reasoning Tab shortcut enabled.",
    };
  }

  if (DISABLE_ARGS.has(rawArg)) {
    return {
      kind: "set",
      enabled: false,
      message: "Reasoning Tab shortcut disabled.",
    };
  }

  return { kind: "invalid", message: USAGE };
}

