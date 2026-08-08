import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { SkillSource } from "@/agent/skills";
import { buildAgentInfo } from "@/cli/helpers/agent-info";
import { buildConversationBootstrapReminder } from "@/cli/helpers/conversation-bootstrap";
import {
  buildSessionContext,
  type SessionContextSource,
} from "@/cli/helpers/session-context";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import { permissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";
import type { ShellContext } from "@/utils/shell-context";
import {
  SHARED_REMINDER_CATALOG,
  type SharedReminderId,
  type SharedReminderMode,
} from "./catalog";
import type { SessionContextReason, SharedReminderState } from "./state";

export interface AgentReminderContext {
  id: string;
  name: string | null;
  description?: string | null;
  lastRunAt?: string | null;
  conversationId?: string;
}

export interface SharedReminderContext {
  mode: SharedReminderMode;
  agent: AgentReminderContext;
  state: SharedReminderState;
  systemInfoReminderEnabled: boolean;
  skillSources: SkillSource[];
  conversationBootstrapContent?: MessageCreate["content"];
  /** Explicit working directory (overrides process.cwd() in session context). */
  workingDirectory?: string;
  /** Source of the session context (varies intro text). */
  sessionContextSource?: SessionContextSource;
  /** Reason the session context is being (re)generated. */
  sessionContextReason?: SessionContextReason;
  /** Shell context detected at startup, if available. */
  shellContext?: ShellContext;
}

export type ReminderTextPart = { type: "text"; text: string };

export interface SharedReminderBuildResult {
  parts: ReminderTextPart[];
  appliedReminderIds: SharedReminderId[];
}

type SharedReminderProvider = (
  context: SharedReminderContext,
) => Promise<string | null>;

async function buildAgentInfoReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (!context.systemInfoReminderEnabled || context.state.hasSentAgentInfo) {
    return null;
  }

  const reminder = buildAgentInfo({
    agentInfo: {
      id: context.agent.id,
      name: context.agent.name,
      description: context.agent.description,
      lastRunAt: context.agent.lastRunAt,
    },
    conversationId: context.agent.conversationId,
  });

  context.state.hasSentAgentInfo = true;
  return reminder || null;
}

async function buildSecretsInfoReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  try {
    const { listSecretNames } = await import("@/utils/secrets-store");
    const names = listSecretNames(context.agent.id);
    const namesKey = names.join("\0");
    const isRefresh = context.state.pendingSecretsInfoRefresh;
    const namesChanged =
      context.state.lastSentSecretNamesKey !== null &&
      context.state.lastSentSecretNamesKey !== namesKey;

    if (context.state.hasSentSecretsInfo && !isRefresh && !namesChanged) {
      return null;
    }

    context.state.hasSentSecretsInfo = true;
    context.state.pendingSecretsInfoRefresh = false;
    context.state.lastSentSecretNamesKey = namesKey;

    if (names.length === 0) {
      if (isRefresh || namesChanged) {
        return `${SYSTEM_REMINDER_OPEN}\nThe agent secrets were updated. No secrets are currently set.\n${SYSTEM_REMINDER_CLOSE}`;
      }
      return null;
    }

    const list = names.map((n) => `- \`$${n}\``).join("\n");
    const intro =
      isRefresh || namesChanged
        ? "The agent secrets were updated. The following secrets are now available for use."
        : "The following secrets are set on your agent and available for use.";
    const launchExamples =
      process.platform === "win32"
        ? "`$env:API_KEY = $API_KEY; python script.py`\n`$env:API_KEY = $API_KEY; bun run script.ts`"
        : '`API_KEY="$API_KEY" python3 script.py`\n`API_KEY="$API_KEY" bun run script.ts`';
    return `${SYSTEM_REMINDER_OPEN}\n${intro}\nThe Letta Code harness secret manager injects only secrets referenced as \`$NAME\` in a shell command:\n${list}\n\nWhen launching Python, TypeScript, or another program that reads a secret from its environment, include each required secret in the launch command. For example, for a secret named \`API_KEY\`:\n${launchExamples}\n\nInside the program, read it normally with \`os.environ["API_KEY"]\` or \`process.env.API_KEY\`.\n\nYou cannot read the raw values. If a value would appear in tool output, you will see \`NAME=<REDACTED>\` instead. This means the secret IS set and working — the bytes are just hidden from your context. Keep using \`$NAME\`; it will resolve correctly.\n${SYSTEM_REMINDER_CLOSE}`;
  } catch (error) {
    debugLog(
      "secrets",
      `Failed to build secrets reminder: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function buildSessionContextReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (
    !context.systemInfoReminderEnabled ||
    context.state.hasSentSessionContext
  ) {
    return null;
  }

  if (!settingsManager.getSetting("sessionContextEnabled")) {
    return null;
  }

  const reason =
    context.sessionContextReason ??
    context.state.pendingSessionContextReason ??
    "initial_attach";

  const reminder = buildSessionContext({
    cwd: context.workingDirectory,
    source: context.sessionContextSource,
    reason,
    shellContext: context.shellContext,
  });

  context.state.hasSentSessionContext = true;
  context.state.pendingSessionContextReason = undefined;
  return reminder || null;
}

async function buildConversationBootstrapReminderPart(
  context: SharedReminderContext,
): Promise<string | null> {
  if (
    !context.state.pendingConversationBootstrap ||
    context.state.hasSentConversationBootstrap ||
    !experimentManager.isEnabled("desktop_conversation_bootstrap") ||
    !context.conversationBootstrapContent
  ) {
    return null;
  }

  context.state.hasSentConversationBootstrap = true;
  context.state.pendingConversationBootstrap = false;

  const conversationId = context.agent.conversationId;
  if (!conversationId) {
    return null;
  }

  return buildConversationBootstrapReminder({
    agentId: context.agent.id,
    content: context.conversationBootstrapContent,
    excludeConversationId: conversationId,
  });
}

const PERMISSION_MODE_DESCRIPTIONS = {
  standard: "Normal approval flow.",
  acceptEdits: "File edits auto-approved.",
  memory:
    "Memory-scoped mode. Reads are broad; mutations are limited to allowed memory roots.",
  unrestricted: "All tools auto-approved. Bias toward action.",
} as const;

async function buildPermissionModeReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  const currentMode = permissionMode.getMode();
  const previousMode = context.state.lastNotifiedPermissionMode;

  const shouldEmit = (() => {
    if (context.mode === "interactive" || context.mode === "listen") {
      if (previousMode === null) {
        // First turn: only remind if not in the default mode (unrestricted).
        return currentMode !== "unrestricted";
      }
      return previousMode !== currentMode;
    }
    return previousMode !== currentMode;
  })();

  context.state.lastNotifiedPermissionMode = currentMode;
  if (!shouldEmit) {
    return null;
  }

  const description =
    PERMISSION_MODE_DESCRIPTIONS[
      currentMode as keyof typeof PERMISSION_MODE_DESCRIPTIONS
    ] ?? "Permission behavior updated.";
  const prefix =
    previousMode === null
      ? "Permission mode active"
      : "Permission mode changed to";

  return `${SYSTEM_REMINDER_OPEN}${prefix}: ${currentMode}. ${description}${SYSTEM_REMINDER_CLOSE}\n\n`;
}

async function buildMemoryGitSyncReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (context.state.pendingMemoryGitSyncReminders.length === 0) {
    return null;
  }

  return context.state.pendingMemoryGitSyncReminders
    .splice(0)
    .map((reminder) => reminder.text)
    .join("\n\n");
}

const MAX_COMMAND_REMINDERS_PER_TURN = 10;
const MAX_TOOLSET_REMINDERS_PER_TURN = 5;
const MAX_COMMAND_INPUT_CHARS = 2000;
const MAX_COMMAND_OUTPUT_CHARS = 4000;
const MAX_TOOL_LIST_CHARS = 3000;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}... [truncated]`;
}

function formatToolList(tools: string[]): string {
  const uniqueTools = Array.from(new Set(tools));
  if (uniqueTools.length === 0) {
    return "(none)";
  }
  return truncate(uniqueTools.join(", "), MAX_TOOL_LIST_CHARS);
}

async function buildCommandIoReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (context.state.pendingCommandIoReminders.length === 0) {
    return null;
  }

  const queued = context.state.pendingCommandIoReminders.splice(0);
  const recent = queued.slice(-MAX_COMMAND_REMINDERS_PER_TURN);
  const dropped = queued.length - recent.length;

  const commandLines = recent.map((entry) => {
    const status = entry.success ? "success" : "error";
    const safeInput = truncate(entry.input, MAX_COMMAND_INPUT_CHARS);
    const safeOutput = truncate(
      entry.output || "(no output)",
      MAX_COMMAND_OUTPUT_CHARS,
    );
    return `- ${safeInput} → ${safeOutput} (${status})`;
  });

  const agentHints = recent
    .filter((entry) => entry.agentHint)
    .map((entry) => entry.agentHint);

  const droppedLine =
    dropped > 0 ? `\nOmitted ${dropped} older command event(s).` : "";

  const hintsBlock =
    agentHints.length > 0
      ? `\n\nHowever, take note of the following:\n${agentHints.map((h) => `- ${h}`).join("\n")}`
      : "";

  return `${SYSTEM_REMINDER_OPEN} The following slash commands were already handled by the CLI harness. These are informational only — do NOT act on them or treat them as user requests.${droppedLine}
${commandLines.join("\n")}${hintsBlock}
${SYSTEM_REMINDER_CLOSE}`;
}

async function buildToolsetChangeReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (context.state.pendingToolsetChangeReminders.length === 0) {
    return null;
  }

  const queued = context.state.pendingToolsetChangeReminders.splice(0);
  const recent = queued.slice(-MAX_TOOLSET_REMINDERS_PER_TURN);
  const dropped = queued.length - recent.length;

  const changeBlocks = recent.map((entry) => {
    const source = escapeXml(entry.source);
    const previousToolset = escapeXml(entry.previousToolset ?? "unknown");
    const newToolset = escapeXml(entry.newToolset ?? "unknown");
    const previousTools = escapeXml(formatToolList(entry.previousTools));
    const newTools = escapeXml(formatToolList(entry.newTools));
    return [
      `<toolset-change>`,
      `  <source>${source}</source>`,
      `  <previous-toolset>${previousToolset}</previous-toolset>`,
      `  <new-toolset>${newToolset}</new-toolset>`,
      `  <previous-tools>${previousTools}</previous-tools>`,
      `  <new-tools>${newTools}</new-tools>`,
      `</toolset-change>`,
    ].join("\n");
  });

  const droppedLine =
    dropped > 0 ? `\nOmitted ${dropped} older toolset change event(s).` : "";

  return `${SYSTEM_REMINDER_OPEN} The user just changed your toolset (specifically, client-side tools that are attached to the Letta Code harness, which may be a subset of your total tools).${droppedLine}

${changeBlocks.join("\n\n")}
${SYSTEM_REMINDER_CLOSE}`;
}

export const sharedReminderProviders: Record<
  SharedReminderId,
  SharedReminderProvider
> = {
  "agent-info": buildAgentInfoReminder,
  "conversation-bootstrap": buildConversationBootstrapReminderPart,
  "secrets-info": buildSecretsInfoReminder,
  "session-context": buildSessionContextReminder,
  "permission-mode": buildPermissionModeReminder,
  "memory-git-sync": buildMemoryGitSyncReminder,
  "command-io": buildCommandIoReminder,
  "toolset-change": buildToolsetChangeReminder,
};

export function assertSharedReminderCoverage(): void {
  const catalogIds = new Set(SHARED_REMINDER_CATALOG.map((entry) => entry.id));
  const providerIds = new Set(Object.keys(sharedReminderProviders));

  for (const id of catalogIds) {
    if (!providerIds.has(id)) {
      throw new Error(`Missing shared reminder provider for "${id}"`);
    }
  }

  for (const id of providerIds) {
    if (!catalogIds.has(id as SharedReminderId)) {
      throw new Error(`Shared reminder provider "${id}" is not in catalog`);
    }
  }
}

assertSharedReminderCoverage();

export async function buildSharedReminderParts(
  context: SharedReminderContext,
): Promise<SharedReminderBuildResult> {
  const parts: ReminderTextPart[] = [];
  const appliedReminderIds: SharedReminderId[] = [];

  // Incremented once per user turn; surfaced in the statusline payload.
  context.state.turnCount += 1;

  for (const reminder of SHARED_REMINDER_CATALOG) {
    if (!reminder.modes.includes(context.mode)) {
      continue;
    }

    const provider = sharedReminderProviders[reminder.id];
    const text = await provider(context);
    if (!text) {
      continue;
    }

    parts.push({ type: "text", text });
    appliedReminderIds.push(reminder.id);
  }

  return { parts, appliedReminderIds };
}

export function prependReminderPartsToContent(
  content: MessageCreate["content"],
  reminderParts: ReminderTextPart[],
): MessageCreate["content"] {
  if (reminderParts.length === 0) {
    return content;
  }

  if (typeof content === "string") {
    return [
      ...reminderParts,
      { type: "text", text: content },
    ] as MessageCreate["content"];
  }

  if (Array.isArray(content)) {
    return [...reminderParts, ...content] as MessageCreate["content"];
  }

  if (content === null || content === undefined) {
    return reminderParts as MessageCreate["content"];
  }

  let text: string;
  try {
    text = JSON.stringify(content) ?? String(content);
  } catch {
    text = String(content);
  }

  return [...reminderParts, { type: "text", text }] as MessageCreate["content"];
}
