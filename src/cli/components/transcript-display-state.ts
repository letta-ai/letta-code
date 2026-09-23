type DisplayKind = "system-reminders" | "thinking";

const expanded: Record<DisplayKind, boolean> = {
  "system-reminders": false,
  thinking: false,
};
let systemRemindersVisible = false;
const listeners: Record<DisplayKind, Set<() => void>> = {
  "system-reminders": new Set(),
  thinking: new Set(),
};
const repaintListeners = new Set<() => void>();

function notifyDisplayChange(kind: DisplayKind): void {
  // Repaint listeners run first so Ink forgets the previous static transcript
  // before the changed display state remounts <Static>.
  for (const listener of repaintListeners) listener();
  for (const listener of listeners[kind]) listener();
}

export function getSystemRemindersExpanded(): boolean {
  return expanded["system-reminders"];
}

export function getSystemRemindersVisible(): boolean {
  return systemRemindersVisible;
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

export function subscribeToTranscriptDisplayRepaint(
  listener: () => void,
): () => void {
  repaintListeners.add(listener);
  return () => repaintListeners.delete(listener);
}

export function toggleSystemReminderDisplay(): void {
  if (!systemRemindersVisible) return;
  expanded["system-reminders"] = !expanded["system-reminders"];
  notifyDisplayChange("system-reminders");
}

export function setSystemRemindersVisible(visible: boolean): void {
  if (systemRemindersVisible === visible) return;
  systemRemindersVisible = visible;
  if (!visible) expanded["system-reminders"] = false;
  notifyDisplayChange("system-reminders");
}

export function setThinkingExpanded(value: boolean): void {
  if (expanded.thinking === value) return;
  expanded.thinking = value;
  notifyDisplayChange("thinking");
}

export function toggleThinkingDisplay(): void {
  setThinkingExpanded(!expanded.thinking);
}

export function handleTranscriptDisplayShortcut(
  input: string,
  key: { ctrl: boolean },
): boolean {
  if (!key.ctrl) return false;
  if (input === "r") {
    toggleSystemReminderDisplay();
    return true;
  }
  if (input === "t") {
    toggleThinkingDisplay();
    return true;
  }
  return false;
}
