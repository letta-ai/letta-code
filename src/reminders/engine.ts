import { join } from "node:path";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getSkillsDirectory } from "../agent/context";
import {
  discoverSkills,
  formatSkillsAsSystemReminder,
  SKILLS_DIR,
  type SkillSource,
} from "../agent/skills";
import { buildAgentInfo } from "../cli/helpers/agentInfo";
import {
  buildCompactionMemoryReminder,
  buildMemoryReminder,
  type ReflectionSettings,
  shouldFireStepCountTrigger,
} from "../cli/helpers/memoryReminder";
import { buildSessionContext } from "../cli/helpers/sessionContext";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import { permissionMode } from "../permissions/mode";
import { settingsManager } from "../settings-manager";
import {
  SHARED_REMINDER_CATALOG,
  type SharedReminderId,
  type SharedReminderMode,
} from "./catalog";
import type { SharedReminderState } from "./state";

type ReflectionTriggerSource = "step-count" | "compaction-event";

export interface AgentReminderContext {
  id: string;
  name: string | null;
  description?: string | null;
  lastRunAt?: string | null;
  serverUrl?: string;
}

export interface SharedReminderContext {
  mode: SharedReminderMode;
  agent: AgentReminderContext;
  state: SharedReminderState;
  sessionContextReminderEnabled: boolean;
  reflectionSettings: ReflectionSettings;
  skillSources: SkillSource[];
  resolvePlanModeReminder: () => string | Promise<string>;
  maybeLaunchReflectionSubagent?: (
    triggerSource: ReflectionTriggerSource,
  ) => Promise<boolean>;
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
  if (context.state.hasSentAgentInfo) {
    return null;
  }

  const reminder = buildAgentInfo({
    agentInfo: {
      id: context.agent.id,
      name: context.agent.name,
      description: context.agent.description,
      lastRunAt: context.agent.lastRunAt,
    },
    serverUrl: context.agent.serverUrl,
  });

  context.state.hasSentAgentInfo = true;
  return reminder || null;
}

async function buildSessionContextReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (
    !context.sessionContextReminderEnabled ||
    context.state.hasSentSessionContext
  ) {
    return null;
  }

  if (!settingsManager.getSetting("sessionContextEnabled")) {
    return null;
  }

  const reminder = buildSessionContext();

  context.state.hasSentSessionContext = true;
  return reminder || null;
}

async function buildSkillsReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  const previousSkillsReminder = context.state.cachedSkillsReminder;
  // Keep a stable empty baseline so a later successful discovery can diff
  // against "" and trigger reinjection, even after an earlier discovery failure.
  let latestSkillsReminder = previousSkillsReminder ?? "";

  try {
    const skillsDir = getSkillsDirectory() || join(process.cwd(), SKILLS_DIR);
    const { skills } = await discoverSkills(skillsDir, context.agent.id, {
      sources: context.skillSources,
    });
    latestSkillsReminder = formatSkillsAsSystemReminder(skills);
    context.state.skillPathById = Object.fromEntries(
      skills
        .filter(
          (skill) => typeof skill.path === "string" && skill.path.length > 0,
        )
        .map((skill) => [skill.id, skill.path as string]),
    );
  } catch {
    // Keep previous snapshot when discovery fails.
  }

  if (
    previousSkillsReminder !== null &&
    previousSkillsReminder !== latestSkillsReminder
  ) {
    context.state.pendingSkillsReinject = true;
  }

  context.state.cachedSkillsReminder = latestSkillsReminder;

  const shouldInject =
    !context.state.hasInjectedSkillsReminder ||
    context.state.pendingSkillsReinject;
  if (!shouldInject) {
    return null;
  }

  context.state.hasInjectedSkillsReminder = true;
  context.state.pendingSkillsReinject = false;
  return latestSkillsReminder || null;
}

async function buildPlanModeReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (permissionMode.getMode() !== "plan") {
    return null;
  }

  const reminder = await context.resolvePlanModeReminder();
  return reminder || null;
}

const PERMISSION_MODE_DESCRIPTIONS = {
  default: "Normal approval flow.",
  acceptEdits: "File edits auto-approved.",
  plan: "Read-only mode. Focus on exploration and planning.",
  bypassPermissions: "All tools auto-approved. Bias toward action.",
} as const;

async function buildPermissionModeReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  const currentMode = permissionMode.getMode();
  const previousMode = context.state.lastNotifiedPermissionMode;

  const shouldEmit = (() => {
    if (context.mode === "interactive") {
      if (previousMode === null) {
        // First turn: only remind if in a non-default mode (e.g. bypassPermissions).
        return currentMode !== "default";
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

async function buildReflectionStepReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  const shouldFireStepTrigger = shouldFireStepCountTrigger(
    context.state.turnCount,
    context.reflectionSettings,
  );

  const memfsEnabled = settingsManager.isMemfsEnabled(context.agent.id);
  let reminder: string | null = null;

  if (shouldFireStepTrigger) {
    if (context.reflectionSettings.behavior === "reminder" || !memfsEnabled) {
      reminder = await buildMemoryReminder(
        context.state.turnCount,
        context.agent.id,
      );
    } else {
      if (context.maybeLaunchReflectionSubagent) {
        await context.maybeLaunchReflectionSubagent("step-count");
      } else {
        reminder = await buildMemoryReminder(
          context.state.turnCount,
          context.agent.id,
        );
      }
    }
  }

  // Keep turn-based cadence aligned across modes by incrementing once per user turn.
  context.state.turnCount += 1;
  return reminder;
}

async function buildReflectionCompactionReminder(
  context: SharedReminderContext,
): Promise<string | null> {
  if (!context.state.pendingReflectionTrigger) {
    return null;
  }

  context.state.pendingReflectionTrigger = false;

  if (context.reflectionSettings.trigger !== "compaction-event") {
    return null;
  }

  const memfsEnabled = settingsManager.isMemfsEnabled(context.agent.id);
  if (context.reflectionSettings.behavior === "auto-launch" && memfsEnabled) {
    if (context.maybeLaunchReflectionSubagent) {
      await context.maybeLaunchReflectionSubagent("compaction-event");
      return null;
    }
  }

  return buildCompactionMemoryReminder(context.agent.id);
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

  const commandBlocks = recent.map((entry) => {
    const status = entry.success ? "success" : "error";
    const safeInput = escapeXml(truncate(entry.input, MAX_COMMAND_INPUT_CHARS));
    const safeOutput = escapeXml(
      truncate(entry.output || "(no output)", MAX_COMMAND_OUTPUT_CHARS),
    );
    return `<user-command>
<user-command-input>${safeInput}</user-command-input>
<user-command-output>${safeOutput}</user-command-output>
<user-command-status>${status}</user-command-status>
</user-command>`;
  });

  const droppedLine =
    dropped > 0 ? `\nOmitted ${dropped} older command event(s).` : "";

  return `${SYSTEM_REMINDER_OPEN}
The following slash commands were executed in the Letta Code harness since your last user message.
Treat these as execution context from the CLI, not new user requests.${droppedLine}
${commandBlocks.join("\n")}
${SYSTEM_REMINDER_CLOSE}

`;
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
    return `<toolset-change>
<source>${source}</source>
<previous-toolset>${previousToolset}</previous-toolset>
<new-toolset>${newToolset}</new-toolset>
<previous-tools>${previousTools}</previous-tools>
<new-tools>${newTools}</new-tools>
</toolset-change>`;
  });

  const droppedLine =
    dropped > 0 ? `\nOmitted ${dropped} older toolset change event(s).` : "";

  return `${SYSTEM_REMINDER_OPEN}
The user just changed your toolset (specifically, client-side tools that are attached to the Letta Code harness, which may be a subset of your total tools).${droppedLine}
${changeBlocks.join("\n")}
${SYSTEM_REMINDER_CLOSE}

`;
}

export const sharedReminderProviders: Record<
  SharedReminderId,
  SharedReminderProvider
> = {
  "agent-info": buildAgentInfoReminder,
  "session-context": buildSessionContextReminder,
  skills: buildSkillsReminder,
  "permission-mode": buildPermissionModeReminder,
  "plan-mode": buildPlanModeReminder,
  "reflection-step-count": buildReflectionStepReminder,
  "reflection-compaction": buildReflectionCompactionReminder,
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

  return content;
}
