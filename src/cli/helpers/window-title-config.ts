// Config resolution and rendering for the terminal window title.
// Precedence: local project > project > global settings.

import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { formatCompact } from "@/cli/helpers/format";
import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";

/** All valid field keys for the window title, in Codex's terminal-title item order. */
export const WINDOW_TITLE_FIELDS = [
  "app-name",
  "project-name",
  "current-dir",
  "activity",
  "run-state",
  "thread-title",
  "git-branch",
  "context-remaining",
  "context-used",
  "five-hour-limit",
  "weekly-limit",
  "version",
  "used-tokens",
  "total-input-tokens",
  "total-output-tokens",
  "thread-id",
  "fast-mode",
  "model",
  "model-with-reasoning",
  "reasoning",
  "task-progress",
  "agent-name",
] as const;

export type WindowTitleField = (typeof WINDOW_TITLE_FIELDS)[number];

/** Items shown in the terminal title when the user has not configured a custom selection. */
export const DEFAULT_WINDOW_TITLE_ITEMS = [
  "activity",
  "agent-name",
] as const satisfies readonly WindowTitleField[];

/** Braille-pattern dot-spinner frames for the terminal title animation. */
export const TERMINAL_TITLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Time between spinner frame advances in the terminal title. */
export const TERMINAL_TITLE_SPINNER_INTERVAL_MS = 100;

/** Time between action-required blink phases in the terminal title. */
export const TERMINAL_TITLE_ACTION_REQUIRED_INTERVAL_MS = 1000;

/** Prefix shown in the terminal title when the agent is blocked on user input. */
export const TERMINAL_TITLE_ACTION_REQUIRED_PREFIX = "[ ! ] Action Required";
export const TERMINAL_TITLE_ACTION_REQUIRED_PREFIX_HIDDEN =
  "[ . ] Action Required";
export const ACTION_REQUIRED_PREVIEW_PREFIX = "[ ! ] Action Required";

/** Human-readable labels and descriptions for each field. */
export const WINDOW_TITLE_FIELD_INFO: Record<
  WindowTitleField,
  { label: string; description: string }
> = {
  "app-name": {
    label: "App Name",
    description: "Letta Code app name",
  },
  "project-name": {
    label: "Project Name",
    description: "Project name (falls back to current directory name)",
  },
  "current-dir": {
    label: "Current Directory",
    description: "Current working directory",
  },
  activity: {
    label: "Activity",
    description:
      "Spinner while working, action-required message while blocked.",
  },
  "run-state": {
    label: "Run State",
    description: "Compact session run-state text (Ready, Working, Thinking)",
  },
  "thread-title": {
    label: "Thread Title",
    description: "Current thread title, or thread identifier when unnamed",
  },
  "git-branch": {
    label: "Git Branch",
    description: "Current Git branch (omitted when unavailable)",
  },
  "context-remaining": {
    label: "Context Remaining",
    description:
      "Percentage of context window remaining (omitted when unknown)",
  },
  "context-used": {
    label: "Context Used",
    description: "Percentage of context window used (omitted when unknown)",
  },
  "five-hour-limit": {
    label: "Five Hour Limit",
    description:
      "Remaining usage on the primary usage limit (omitted when unavailable)",
  },
  "weekly-limit": {
    label: "Weekly Limit",
    description:
      "Remaining usage on the secondary usage limit (omitted when unavailable)",
  },
  version: {
    label: "Version",
    description: "Letta Code application version",
  },
  "used-tokens": {
    label: "Used Tokens",
    description: "Total tokens used in session (omitted when zero)",
  },
  "total-input-tokens": {
    label: "Total Input Tokens",
    description: "Total input tokens used in session",
  },
  "total-output-tokens": {
    label: "Total Output Tokens",
    description: "Total output tokens used in session",
  },
  "thread-id": {
    label: "Thread ID",
    description: "Current thread identifier (omitted until thread starts)",
  },
  "fast-mode": {
    label: "Fast Mode",
    description: "Whether Fast mode is currently active",
  },
  model: {
    label: "Model",
    description: "Current model name",
  },
  "model-with-reasoning": {
    label: "Model + Reasoning",
    description: "Current model name with reasoning level",
  },
  reasoning: {
    label: "Reasoning",
    description: "Current reasoning level",
  },
  "task-progress": {
    label: "Task Progress",
    description:
      "Latest task progress from update_plan (omitted until available)",
  },
  "agent-name": {
    label: "Agent Name",
    description: "Current agent's name",
  },
};

const WINDOW_TITLE_FIELD_ALIASES: Record<string, WindowTitleField> = {
  project: "project-name",
  spinner: "activity",
  status: "run-state",
  thread: "thread-title",
  "context-usage": "context-used",
  "codex-version": "version",
  "session-id": "thread-id",
  "model-name": "model",
  "conversation-name": "thread-title",
};

/** Data available for rendering the window title. */
export interface WindowTitleData {
  agentName?: string | null;
  appName?: string | null;
  version: string;
  conversationSummary?: string | null;
  conversationId?: string | null;
  projectDirectory?: string | null;
  currentDirectory?: string | null;
  activityFrame?: string | null;
  runState?: string | null;
  modelDisplayName?: string | null;
  reasoningEffort?: string | null;
  contextUsedPercentage?: number | null;
  contextRemainingPercentage?: number | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  gitBranch?: string | null;
  fastMode?: boolean | null;
  taskProgress?: string | null;
}

export function isWindowTitleField(value: string): value is WindowTitleField {
  return (WINDOW_TITLE_FIELDS as readonly string[]).includes(value);
}

export function parseWindowTitleField(value: string): WindowTitleField | null {
  const trimmed = value.trim();
  if (isWindowTitleField(trimmed)) {
    return trimmed;
  }
  return WINDOW_TITLE_FIELD_ALIASES[trimmed] ?? null;
}

export function normalizeWindowTitleItems(
  items: readonly string[],
): WindowTitleField[] {
  return items.flatMap((item) => {
    const parsed = parseWindowTitleField(item);
    return parsed ? [parsed] : [];
  });
}

/**
 * Resolve the effective window title items from all settings levels.
 * Returns the Codex default items when no config is set. An explicitly empty
 * configured list is preserved and means "clear the managed title".
 */
export function resolveWindowTitleConfig(
  workingDirectory: string = process.cwd(),
): WindowTitleField[] {
  try {
    const local = resolveItemsFromConfig(
      () =>
        settingsManager.getLocalProjectSettings(workingDirectory)?.windowTitle,
    );
    if (local) return local;

    const project = resolveItemsFromConfig(
      () => settingsManager.getProjectSettings(workingDirectory)?.windowTitle,
    );
    if (project) return project;

    const global = resolveItemsFromConfig(
      () => settingsManager.getSettings().windowTitle,
    );
    if (global) return global;

    return [...DEFAULT_WINDOW_TITLE_ITEMS];
  } catch (error) {
    debugLog(
      "windowtitle",
      "resolveWindowTitleConfig: Failed to resolve config",
      error,
    );
    return [...DEFAULT_WINDOW_TITLE_ITEMS];
  }
}

/**
 * Render the terminal window title from the selected items and available data.
 *
 * Values render in configured order. Unavailable values are omitted. The
 * activity item uses Codex's separator rule: a plain space next to activity,
 * and ` | ` between all other adjacent rendered items.
 */
export function renderWindowTitle(
  items: readonly WindowTitleField[],
  data: WindowTitleData,
): string | null {
  let previous: WindowTitleField | null = null;
  let title = "";

  for (const item of items) {
    const value = resolveFieldValue(item, data);
    if (value === null) continue;

    title += separatorFromPrevious(item, previous);
    title += value;
    previous = item;
  }

  return title.length > 0 ? title : null;
}

export function renderActionRequiredWindowTitle(
  items: readonly WindowTitleField[],
  data: WindowTitleData,
  prefix: string,
): string {
  return buildActionRequiredTitleText(prefix, items, ["run-state"], data);
}

export function previewLineForWindowTitleItems(
  items: readonly WindowTitleField[],
  data: WindowTitleData,
): string | null {
  if (items.includes("activity")) {
    return buildActionRequiredTitleText(
      ACTION_REQUIRED_PREVIEW_PREFIX,
      items,
      [],
      data,
    );
  }

  return renderWindowTitle(items, data);
}

export function buildActionRequiredTitleText(
  prefix: string,
  items: readonly WindowTitleField[],
  excludedItems: readonly WindowTitleField[],
  data: WindowTitleData,
): string {
  const parts = [prefix];

  for (const item of items) {
    if (item === "activity" || excludedItems.includes(item)) continue;
    const value = resolveFieldValue(item, data);
    if (value !== null) {
      parts.push(value);
    }
  }

  return parts.join(" | ");
}

export function titleUsesActivity(items: readonly WindowTitleField[]): boolean {
  return items.includes("activity");
}

export function separatorFromPrevious(
  item: WindowTitleField,
  previous: WindowTitleField | null,
): string {
  if (previous === null) return "";
  if (previous === "activity" || item === "activity") return " ";
  return " | ";
}

export function truncateTerminalTitlePart(
  value: string,
  maxChars: number,
): string {
  if (maxChars === 0) {
    return "";
  }

  const parts = graphemeClusters(value);
  const head = parts.slice(0, maxChars).join("");
  if (parts.length <= maxChars || maxChars <= 3) {
    return head;
  }

  return `${parts.slice(0, maxChars - 3).join("")}...`;
}

function resolveItemsFromConfig(
  getConfig: () => { items?: string[] } | undefined,
): WindowTitleField[] | null {
  try {
    const config = getConfig();
    if (!config || !Array.isArray(config.items)) return null;
    return normalizeWindowTitleItems(config.items);
  } catch {
    return null;
  }
}

function resolveFieldValue(
  item: WindowTitleField,
  data: WindowTitleData,
): string | null {
  switch (item) {
    case "app-name":
      return data.appName || null;
    case "project-name":
      return terminalTitleProjectName(data);
    case "current-dir":
      return truncateOptional(formatDirectoryDisplay(titleDirectory(data)), 32);
    case "activity":
      return data.activityFrame || null;
    case "run-state":
      return data.runState || null;
    case "thread-title": {
      const threadTitle =
        nonEmpty(data.conversationSummary) ?? data.conversationId;
      return truncateOptional(threadTitle, 48);
    }
    case "git-branch":
      return truncateOptional(data.gitBranch, 32);
    case "context-remaining":
      return typeof data.contextRemainingPercentage === "number"
        ? `Context ${data.contextRemainingPercentage}% left`
        : null;
    case "context-used":
      return typeof data.contextUsedPercentage === "number"
        ? `Context ${data.contextUsedPercentage}% used`
        : null;
    case "five-hour-limit":
    case "weekly-limit":
      return null;
    case "version":
      return truncateTerminalTitlePart(data.version, 32);
    case "used-tokens": {
      const total =
        Math.max(0, Math.floor(data.totalInputTokens ?? 0)) +
        Math.max(0, Math.floor(data.totalOutputTokens ?? 0));
      return total > 0 ? `${formatCompact(total)} used` : null;
    }
    case "total-input-tokens":
      return `${formatCompact(Math.max(0, Math.floor(data.totalInputTokens ?? 0)))} in`;
    case "total-output-tokens":
      return `${formatCompact(Math.max(0, Math.floor(data.totalOutputTokens ?? 0)))} out`;
    case "thread-id":
      return truncateOptional(data.conversationId, 32);
    case "fast-mode":
      return data.fastMode === null || data.fastMode === undefined
        ? null
        : data.fastMode
          ? "Fast on"
          : "Fast off";
    case "model":
      return truncateOptional(data.modelDisplayName, 32);
    case "model-with-reasoning": {
      const model = nonEmpty(data.modelDisplayName);
      if (!model) return null;
      return truncateTerminalTitlePart(
        `${model} ${reasoningDisplayName(data.reasoningEffort)}`,
        32,
      );
    }
    case "reasoning":
      return reasoningDisplayName(data.reasoningEffort);
    case "task-progress":
      return data.taskProgress || null;
    case "agent-name":
      return truncateOptional(data.agentName, 32);
  }
}

function terminalTitleProjectName(data: WindowTitleData): string | null {
  const directory = titleDirectory(data);
  if (!directory) return null;

  const resolved = resolve(directory);
  const name =
    basename(resolved) || formatDirectoryDisplay(resolved) || resolved;
  return truncateTerminalTitlePart(name, 24);
}

function titleDirectory(data: WindowTitleData): string | null {
  return data.projectDirectory || data.currentDirectory || null;
}

function formatDirectoryDisplay(directory: string | null): string | null {
  if (!directory) return null;

  const resolved = resolve(directory);
  const home = homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}/`)) {
    return `~/${resolved.slice(home.length + 1)}`;
  }
  return resolved;
}

function reasoningDisplayName(
  reasoningEffort: string | null | undefined,
): string {
  return reasoningEffort && reasoningEffort !== "none"
    ? reasoningEffort
    : "default";
}

function truncateOptional(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  const trimmed = nonEmpty(value);
  return trimmed ? truncateTerminalTitlePart(trimmed, maxChars) : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

type SegmenterLike = new (
  locale: string | undefined,
  options: { granularity: "grapheme" },
) => { segment(value: string): Iterable<{ segment: string }> };

function graphemeClusters(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterLike })
    .Segmenter;
  if (!Segmenter) {
    return Array.from(value);
  }

  return Array.from(
    new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (part) => part.segment,
  );
}
