type DisplayKind = "system-reminders" | "thinking";

const expanded: Record<DisplayKind, boolean> = {
  "system-reminders": false,
  thinking: false,
};
const listeners: Record<DisplayKind, Set<() => void>> = {
  "system-reminders": new Set(),
  thinking: new Set(),
};

export function getSystemRemindersExpanded(): boolean {
  return expanded["system-reminders"];
}

export function getThinkingExpanded(): boolean {
  return expanded.thinking;
}

export function subscribeToSystemReminderDisplay(
  listener: () => void,
): () => void {
  listeners["system-reminders"].add(listener);
  return () => listeners["system-reminders"].delete(listener);
}

export function subscribeToThinkingDisplay(listener: () => void): () => void {
  listeners.thinking.add(listener);
  return () => listeners.thinking.delete(listener);
}

export function toggleSystemReminderDisplay(): void {
  expanded["system-reminders"] = !expanded["system-reminders"];
  for (const listener of listeners["system-reminders"]) listener();
}

export function toggleThinkingDisplay(): void {
  expanded.thinking = !expanded.thinking;
  for (const listener of listeners.thinking) listener();
}
