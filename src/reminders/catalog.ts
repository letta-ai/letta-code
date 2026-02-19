export type SharedReminderMode =
  | "interactive"
  | "headless-one-shot"
  | "headless-bidirectional";

export type SharedReminderId =
  | "session-context"
  | "skills"
  | "permission-mode"
  | "plan-mode"
  | "reflection-step-count"
  | "reflection-compaction"
  | "command-io"
  | "toolset-change";

export interface SharedReminderDefinition {
  id: SharedReminderId;
  description: string;
  modes: SharedReminderMode[];
}

export const SHARED_REMINDER_CATALOG: ReadonlyArray<SharedReminderDefinition> =
  [
    {
      id: "session-context",
      description: "First-turn device/agent/git context",
      modes: ["interactive", "headless-one-shot", "headless-bidirectional"],
    },
    {
      id: "skills",
      description: "Available skills system reminder (with reinjection)",
      modes: ["interactive", "headless-one-shot", "headless-bidirectional"],
    },
    {
      id: "permission-mode",
      description: "Permission mode reminder",
      modes: ["interactive", "headless-one-shot", "headless-bidirectional"],
    },
    {
      id: "plan-mode",
      description: "Plan mode behavioral reminder",
      modes: ["interactive", "headless-one-shot", "headless-bidirectional"],
    },
    {
      id: "reflection-step-count",
      description: "Step-count reflection reminder/auto-launch behavior",
      modes: ["interactive", "headless-one-shot", "headless-bidirectional"],
    },
    {
      id: "reflection-compaction",
      description:
        "Compaction-triggered reflection reminder/auto-launch behavior",
      modes: ["interactive", "headless-one-shot", "headless-bidirectional"],
    },
    {
      id: "command-io",
      description: "Recent slash command input/output context",
      modes: ["interactive"],
    },
    {
      id: "toolset-change",
      description: "Client-side toolset change context",
      modes: ["interactive"],
    },
  ];

export const SHARED_REMINDER_IDS = SHARED_REMINDER_CATALOG.map(
  (entry) => entry.id,
);

const SHARED_REMINDER_BY_ID = new Map<
  SharedReminderId,
  SharedReminderDefinition
>(SHARED_REMINDER_CATALOG.map((entry) => [entry.id, entry]));

export function reminderEnabledInMode(
  id: SharedReminderId,
  mode: SharedReminderMode,
): boolean {
  return SHARED_REMINDER_BY_ID.get(id)?.modes.includes(mode) ?? false;
}
