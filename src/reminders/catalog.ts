export type SharedReminderMode =
  | "interactive"
  | "headless-one-shot"
  | "headless-bidirectional"
  | "listen"
  | "subagent";

export type SharedReminderId =
  | "session-context"
  | "conversation-bootstrap"
  | "agent-info"
  | "secrets-info"
  | "permission-mode"
  | "memory-git-sync"
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
      description: "First-turn device/git/cwd context",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "conversation-bootstrap",
      description: "First-turn prior-conversation bootstrap context",
      modes: ["interactive"],
    },
    {
      id: "agent-info",
      description: "Agent identity (ID, name, server, memory dir)",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "secrets-info",
      description: "Available secret names for $SECRET_NAME substitution",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "permission-mode",
      description: "Permission mode reminder",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
    },
    {
      id: "memory-git-sync",
      description: "Queued post-turn memory git sync status",
      modes: [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ],
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
