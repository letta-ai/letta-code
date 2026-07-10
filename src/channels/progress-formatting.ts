import { basename } from "node:path";
import {
  isFileEditTool,
  isFileReadTool,
  isFileWriteTool,
  isGlobTool,
  isSearchTool,
  isShellTool,
  isTaskTool,
  isWebSearchTool,
} from "@/cli/helpers/tool-name-mapping";

const MAX_PROGRESS_TEXT_LENGTH = 140;
export const MAX_PROGRESS_DETAILS_LENGTH = 180;
const MAX_SHELL_PROGRESS_DETAILS_LENGTH = 64;
const MAX_SUBAGENT_PROGRESS_DETAILS_LENGTH = 180;
const ESCAPE_CODE = String.fromCharCode(27);
const ANSI_ESCAPE_RE = new RegExp(`${ESCAPE_CODE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_JSON_RE =
  /(["']?(?:token|secret|password|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function truncateChannelProgressText(
  value: string,
  maxLength: number,
  marker = "...",
): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= marker.length) {
    return marker.slice(0, Math.max(0, maxLength));
  }
  return `${value.slice(0, maxLength - marker.length).trimEnd()}${marker}`;
}

function replaceControlCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = character.charCodeAt(0);
    result +=
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
        ? " "
        : character;
  }
  return result;
}

/**
 * Shared sanitization core for channel-facing progress text: strips ANSI
 * escapes and control characters, redacts secret-looking assignments, and
 * neutralizes platform mentions. Platform adapters layer their own escaping
 * (and truncation marker) on top of this instead of maintaining parallel
 * redaction rules.
 */
export function sanitizeChannelProgressCore(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const redacted = raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(SECRET_ASSIGNMENT_RE, "$1=[redacted]")
    .replace(SECRET_JSON_RE, "$1[redacted]");
  return replaceControlCharacters(redacted)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/@(?=channel|here|everyone|[A-Za-z0-9._-]+)/gi, "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeChannelProgressText(
  value: unknown,
  maxLength: number = MAX_PROGRESS_TEXT_LENGTH,
): string {
  return truncateChannelProgressText(
    sanitizeChannelProgressCore(value),
    maxLength,
  );
}

export function sanitizeChannelProgressIdentifier(
  value: unknown,
  fallback: string,
): string {
  const text = sanitizeChannelProgressText(value, 64);
  if (!text) {
    return fallback;
  }
  const cleaned = text.replace(/[^A-Za-z0-9_.:/ -]/g, "").trim();
  return cleaned || fallback;
}

function summarizeShellCommand(command: string): string {
  const normalized = sanitizeChannelProgressText(command, 10_000);
  if (!normalized) {
    return "";
  }

  // Preview the first command segment (or two short ones) and drop pipelines
  // so multi-step shell invocations stay readable at Slack-row lengths.
  const segments = normalized
    .split(/\s*;\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const firstTwoSegments = segments.slice(0, 2).join("; ");
  const previewSource =
    firstTwoSegments.length > 0 && firstTwoSegments.length <= 70
      ? firstTwoSegments
      : (segments[0] ?? normalized);
  const withoutPipeline = previewSource.split(/\s*\|\s*/)[0] ?? previewSource;

  return sanitizeChannelProgressText(
    withoutPipeline.trim() || normalized,
    MAX_SHELL_PROGRESS_DETAILS_LENGTH,
  );
}

type SkillDescriptionLookup =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string | undefined>>;

export type ChannelTurnProgressBuilderOptions = {
  skillDescriptionsByName?: SkillDescriptionLookup;
};

export type ToolCallSummary = {
  id?: string;
  name?: string;
  argumentsText?: string;
};

function getSkillNameFromArguments(
  parsedArguments: Record<string, unknown>,
): string | undefined {
  return firstNonEmptyString(parsedArguments.skill, parsedArguments.skillName);
}

function getFragmentedSkillName(summary: ToolCallSummary): string | undefined {
  const skillMatch = summary.argumentsText?.match(
    /"(?:skill|skillName)"\s*:\s*"([^"]+)"/,
  );
  return skillMatch?.[1];
}

function resolveSkillDescription(
  skillName: string | undefined,
  options: ChannelTurnProgressBuilderOptions | undefined,
): string | undefined {
  const lookup = options?.skillDescriptionsByName;
  if (!skillName || !lookup) {
    return undefined;
  }
  if ("get" in lookup && typeof lookup.get === "function") {
    return firstNonEmptyString(lookup.get(skillName));
  }
  return firstNonEmptyString(
    (lookup as Readonly<Record<string, string | undefined>>)[skillName],
  );
}

function formatSkillProgressTitleFromName(
  skillName: string | undefined,
): string | undefined {
  const sanitized = sanitizeChannelProgressText(
    skillName,
    MAX_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized ? `Skill: ${sanitized}` : undefined;
}

function formatShellProgressDetailsFromArguments(
  parsedArguments: Record<string, unknown>,
): string | undefined {
  const description = firstNonEmptyString(parsedArguments.description);
  if (description) {
    return (
      sanitizeChannelProgressText(description, MAX_PROGRESS_DETAILS_LENGTH) ||
      undefined
    );
  }

  const commandPreview = firstNonEmptyString(
    parsedArguments.command,
    parsedArguments.cmd,
  );
  return summarizeShellCommand(commandPreview ?? "") || undefined;
}

function formatFragmentedShellProgressDetails(
  summary: ToolCallSummary,
): string | undefined {
  const descriptionMatch = summary.argumentsText?.match(
    /"description"\s*:\s*"([^"]+)"/,
  );
  if (descriptionMatch?.[1]) {
    return (
      sanitizeChannelProgressText(
        descriptionMatch[1],
        MAX_PROGRESS_DETAILS_LENGTH,
      ) || undefined
    );
  }

  // Do not expose command previews from incomplete shell-tool JSON. Slack's
  // task stream appends, rather than replaces, changed details for the same
  // task id; sending a provisional command before the streamed description
  // arrives leaves both strings glued together in the preview.
  return undefined;
}

function formatSubagentProgressDetailsFromArguments(
  parsedArguments: Record<string, unknown>,
): string | undefined {
  const preview = firstNonEmptyString(
    parsedArguments.prompt,
    parsedArguments.description,
    parsedArguments.subject,
  );
  const sanitized = sanitizeChannelProgressText(
    preview,
    MAX_SUBAGENT_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized || undefined;
}

function formatFragmentedSubagentProgressDetails(
  summary: ToolCallSummary,
): string | undefined {
  const previewMatch = summary.argumentsText?.match(
    /"(?:prompt|description|subject)"\s*:\s*"([^"]+)"/,
  );
  if (!previewMatch?.[1]) {
    return undefined;
  }
  const sanitized = sanitizeChannelProgressText(
    previewMatch[1],
    MAX_SUBAGENT_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized || undefined;
}

export type ToolReturnSummary = {
  summary: ToolCallSummary;
  status: "completed" | "error";
  errorDetails?: string;
};

export function parseToolArguments(
  value: string | undefined,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function isFetchWebpageToolName(name: string | undefined): boolean {
  return (
    name === "fetch_webpage" ||
    name === "FetchWebpage" ||
    name === "fetchWebpage"
  );
}

export function isSkillToolName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const normalized = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1)
    : name;
  return normalized === "Skill" || normalized === "skill";
}

function isFilePathToolName(name: string): boolean {
  return isFileReadTool(name) || isFileWriteTool(name) || isFileEditTool(name);
}

function getFileToolKind(name: string): "read" | "write" | "update" | null {
  if (isFileReadTool(name)) {
    return "read";
  }
  if (isFileWriteTool(name)) {
    return "write";
  }
  if (isFileEditTool(name)) {
    return "update";
  }
  return null;
}

function countProgressLines(value: string | undefined): number {
  return value ? value.split("\n").length : 0;
}

type LineChangeSummary = {
  additions?: number;
  deletions?: number;
};

function formatLineChangeSummary(summary: LineChangeSummary | null): string {
  if (!summary) {
    return "";
  }
  const parts: string[] = [];
  if (summary.additions !== undefined) {
    parts.push(`+${summary.additions}`);
  }
  if (summary.deletions !== undefined) {
    parts.push(`-${summary.deletions}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function extractFilePathFromArguments(
  parsedArguments: Record<string, unknown>,
): string | undefined {
  return firstNonEmptyString(
    parsedArguments.file_path,
    parsedArguments.filePath,
    parsedArguments.path,
  );
}

function formatProgressFileName(
  filePath: string | undefined,
): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const fileName = basename(filePath) || filePath;
  return (
    sanitizeChannelProgressText(fileName, MAX_PROGRESS_DETAILS_LENGTH) ||
    undefined
  );
}

function getEditLineChangeSummary(
  parsedArguments: Record<string, unknown>,
): LineChangeSummary | null {
  const oldString = firstNonEmptyString(parsedArguments.old_string);
  const newString = firstNonEmptyString(parsedArguments.new_string);
  if (oldString === undefined || newString === undefined) {
    return null;
  }
  return {
    additions: countProgressLines(newString),
    deletions: countProgressLines(oldString),
  };
}

function getMultiEditLineChangeSummary(
  parsedArguments: Record<string, unknown>,
): LineChangeSummary | null {
  if (!Array.isArray(parsedArguments.edits)) {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  let counted = false;
  for (const edit of parsedArguments.edits) {
    const record = asRecord(edit);
    if (!record) {
      continue;
    }
    const oldString = firstNonEmptyString(record.old_string);
    const newString = firstNonEmptyString(record.new_string);
    if (oldString === undefined || newString === undefined) {
      continue;
    }
    additions += countProgressLines(newString);
    deletions += countProgressLines(oldString);
    counted = true;
  }
  return counted ? { additions, deletions } : null;
}

function getWriteLineChangeSummary(
  parsedArguments: Record<string, unknown>,
): LineChangeSummary | null {
  const content = firstNonEmptyString(parsedArguments.content);
  if (content === undefined) {
    return null;
  }
  return {
    additions: countProgressLines(content),
  };
}

function getFileLineChangeSummary(
  name: string,
  parsedArguments: Record<string, unknown>,
): LineChangeSummary | null {
  if (isFileWriteTool(name)) {
    return getWriteLineChangeSummary(parsedArguments);
  }
  if (name === "MultiEdit" || name === "multi_edit") {
    return getMultiEditLineChangeSummary(parsedArguments);
  }
  if (isFileEditTool(name)) {
    return getEditLineChangeSummary(parsedArguments);
  }
  return null;
}

function getFileToolVerb(
  kind: "read" | "write" | "update",
  status: "started" | "completed" | "error",
): string {
  if (status === "error") {
    if (kind === "read") {
      return "Tried to read";
    }
    if (kind === "write") {
      return "Tried to write";
    }
    return "Tried to update";
  }
  if (status === "started") {
    if (kind === "read") {
      return "Reading";
    }
    if (kind === "write") {
      return "Writing";
    }
    return "Updating";
  }
  if (kind === "read") {
    return "Read";
  }
  if (kind === "write") {
    return "Wrote";
  }
  return "Updated";
}

function formatFileToolProgressTitle(
  name: string,
  parsedArguments: Record<string, unknown>,
  status: "started" | "completed" | "error",
): string | undefined {
  const kind = getFileToolKind(name);
  if (!kind) {
    return undefined;
  }
  const fileName = formatProgressFileName(
    extractFilePathFromArguments(parsedArguments),
  );
  if (!fileName) {
    return undefined;
  }
  const stats =
    status === "completed"
      ? formatLineChangeSummary(getFileLineChangeSummary(name, parsedArguments))
      : "";
  return `${getFileToolVerb(kind, status)} ${fileName}${stats}`;
}

function formatFragmentedFileToolProgressTitle(
  summary: ToolCallSummary,
  status: "started" | "completed" | "error",
): string | undefined {
  if (!summary.name || !summary.argumentsText) {
    return undefined;
  }
  const kind = getFileToolKind(summary.name);
  if (!kind) {
    return undefined;
  }
  const filePathMatch = summary.argumentsText.match(
    /"(?:file_path|filePath|path)"\s*:\s*"([^"]+)"/,
  );
  const fileName = formatProgressFileName(filePathMatch?.[1]);
  if (!fileName) {
    return undefined;
  }
  return `${getFileToolVerb(kind, status)} ${fileName}`;
}

export function formatToolProgressTitle(
  summary: ToolCallSummary,
  status: "started" | "completed" | "error",
): string | undefined {
  if (!summary.name || !summary.argumentsText) {
    return undefined;
  }

  const parsedArguments = parseToolArguments(summary.argumentsText);
  if (parsedArguments) {
    if (isSkillToolName(summary.name)) {
      return formatSkillProgressTitleFromName(
        getSkillNameFromArguments(parsedArguments),
      );
    }
    if (isFilePathToolName(summary.name)) {
      return formatFileToolProgressTitle(summary.name, parsedArguments, status);
    }
    return undefined;
  }

  if (isSkillToolName(summary.name)) {
    return formatSkillProgressTitleFromName(getFragmentedSkillName(summary));
  }
  if (isFilePathToolName(summary.name)) {
    return formatFragmentedFileToolProgressTitle(summary, status);
  }
  return undefined;
}

function formatSkillProgressDetailsFromArguments(
  parsedArguments: Record<string, unknown>,
  options: ChannelTurnProgressBuilderOptions | undefined,
): string | undefined {
  const skillName = getSkillNameFromArguments(parsedArguments);
  const detail = resolveSkillDescription(skillName, options) ?? skillName;
  const sanitized = sanitizeChannelProgressText(
    detail,
    MAX_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized || undefined;
}

function formatFragmentedSkillProgressDetails(
  summary: ToolCallSummary,
  options: ChannelTurnProgressBuilderOptions | undefined,
): string | undefined {
  const skillName = getFragmentedSkillName(summary);
  const detail = resolveSkillDescription(skillName, options) ?? skillName;
  const sanitized = sanitizeChannelProgressText(
    detail,
    MAX_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized || undefined;
}

export function formatToolProgressDetails(
  summary: ToolCallSummary,
  options?: ChannelTurnProgressBuilderOptions,
): string | undefined {
  if (!summary.name || !summary.argumentsText) {
    return undefined;
  }

  // Try JSON parse first (complete arguments)
  const parsedArguments = parseToolArguments(summary.argumentsText);
  if (parsedArguments) {
    if (isWebSearchTool(summary.name)) {
      const query = firstNonEmptyString(parsedArguments.query);
      const sanitized = sanitizeChannelProgressText(
        query,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (isFetchWebpageToolName(summary.name)) {
      const url = firstNonEmptyString(parsedArguments.url);
      const sanitized = sanitizeChannelProgressText(
        url,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (isSkillToolName(summary.name)) {
      return formatSkillProgressDetailsFromArguments(parsedArguments, options);
    }

    if (isTaskTool(summary.name)) {
      return formatSubagentProgressDetailsFromArguments(parsedArguments);
    }

    if (isShellTool(summary.name)) {
      return formatShellProgressDetailsFromArguments(parsedArguments);
    }

    if (isFilePathToolName(summary.name)) {
      const filePath = firstNonEmptyString(
        parsedArguments.file_path,
        parsedArguments.filePath,
        parsedArguments.path,
      );
      const sanitized = sanitizeChannelProgressText(
        filePath,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (isGlobTool(summary.name) || isSearchTool(summary.name)) {
      const pattern = firstNonEmptyString(parsedArguments.pattern);
      const sanitized = sanitizeChannelProgressText(
        pattern,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    return undefined;
  }

  // Fallback: extract known preview fields from fragmented/incomplete JSON.
  if (isShellTool(summary.name)) {
    return formatFragmentedShellProgressDetails(summary);
  }

  if (isSkillToolName(summary.name)) {
    return formatFragmentedSkillProgressDetails(summary, options);
  }

  if (isTaskTool(summary.name)) {
    return formatFragmentedSubagentProgressDetails(summary);
  }

  if (isFilePathToolName(summary.name)) {
    const filePathMatch = summary.argumentsText.match(
      /"file_path"\s*:\s*"([^"]+)"/,
    );
    if (filePathMatch?.[1]) {
      const sanitized = sanitizeChannelProgressText(
        filePathMatch[1],
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }
  }

  return undefined;
}
