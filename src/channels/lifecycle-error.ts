import {
  buildConversationBusyErrorBody,
  CONVERSATION_BUSY_TITLE,
  isConversationBusyErrorText,
} from "@/utils/conversation-busy-error";

const RAW_LOOP_ERROR_PATTERN = /^Unexpected stop reason:\s*error$/i;
const APP_CHAT_URL_PATTERN = /https:\/\/app\.letta\.com\/chat\/\S+/i;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const OSC8_PREFIX = `${ESCAPE_CHARACTER}]8;;`;
const OSC8_TERMINATOR = `${ESCAPE_CHARACTER}\\`;

const APPROVAL_PENDING_ERROR_PATTERNS = [
  /waiting for approval/i,
  /pending request before continuing/i,
  /approve or deny the pending request/i,
];

const LETTA_CLOUD_DATABASE_LOCK_TIMEOUT_PATTERN =
  /\bcancel(?:l)?ing statement due to lock timeout\b/i;
const POSTGRES_LOCK_NOT_AVAILABLE_CODE_PATTERN = /\b55P03\b/i;
const POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE_PATTERN =
  /\b(?:sqlstate|pgcode)\s*[:=]?\s*["']?55P03\b/i;
const POSTGRES_LOCK_NOT_AVAILABLE_CONTEXT_PATTERN =
  /\b(?:postgres(?:ql)?|psycopg|sqlalchemy|lock[_ -]?not[_ -]?available|lock timeout)\b/i;

const RUN_ID_PATTERNS = [
  /"run_id"\s*:\s*"([^"\\]+)"/i,
  /\brun[_\s-]?id\b["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i,
  /\(run:\s*([A-Za-z0-9_-]+)\)/i,
];

export type ChannelLifecycleErrorKind =
  | "approval_pending"
  | "conversation_busy"
  | "letta_cloud_busy"
  | "generic";

export interface ChannelLifecycleErrorDisplayOptions {
  automaticRetry?: boolean;
  runId?: string | null;
}

export interface ChannelLifecycleErrorDisplay {
  kind: ChannelLifecycleErrorKind;
  title: string;
  body: string;
  runId?: string;
}

export interface ChannelLifecycleErrorFormatOptions
  extends ChannelLifecycleErrorDisplayOptions {
  codeBlock?: boolean;
  maxLength?: number;
}

export const CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE =
  "Something went wrong while processing that message. Please try again.";

export const CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE =
  "The agent is still waiting on a tool approval from an earlier turn. Please approve or deny that pending request, then send your message again.";

export const CHANNEL_LIFECYCLE_LETTA_CLOUD_BUSY_MESSAGE =
  "Letta Cloud was temporarily busy, so the turn could not finish. Please try again.";

export const CHANNEL_LIFECYCLE_CONVERSATION_BUSY_TITLE =
  CONVERSATION_BUSY_TITLE;

function stripTrailingRunIdPunctuation(runId: string): string {
  return runId.replace(/[)"'.,;]+$/g, "");
}

export function extractChannelLifecycleRunId(
  errorText: string | null | undefined,
): string | undefined {
  if (!errorText) return undefined;
  for (const pattern of RUN_ID_PATTERNS) {
    const match = errorText.match(pattern);
    const runId = match?.[1]?.trim();
    if (runId) {
      return stripTrailingRunIdPunctuation(runId);
    }
  }
  return undefined;
}

function stripOsc8TerminalLinks(errorText: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < errorText.length) {
    const linkStart = errorText.indexOf(OSC8_PREFIX, cursor);
    if (linkStart === -1) {
      output += errorText.slice(cursor);
      break;
    }

    const labelStart = errorText.indexOf(
      OSC8_TERMINATOR,
      linkStart + OSC8_PREFIX.length,
    );
    if (labelStart === -1) {
      output += errorText.slice(cursor);
      break;
    }

    const closeStart = errorText.indexOf(
      OSC8_PREFIX,
      labelStart + OSC8_TERMINATOR.length,
    );
    if (closeStart === -1) {
      output += errorText.slice(cursor);
      break;
    }

    const closeEnd = errorText.indexOf(
      OSC8_TERMINATOR,
      closeStart + OSC8_PREFIX.length,
    );
    if (closeEnd === -1) {
      output += errorText.slice(cursor);
      break;
    }

    output += errorText.slice(cursor, linkStart);
    output += errorText.slice(labelStart + OSC8_TERMINATOR.length, closeStart);
    cursor = closeEnd + OSC8_TERMINATOR.length;
  }

  return output;
}

export function sanitizeChannelLifecycleErrorText(
  errorText: string | null | undefined,
): string {
  if (!errorText) return "";

  const withoutTerminalLinks = stripOsc8TerminalLinks(errorText);

  return withoutTerminalLinks
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (/^View agent:/i.test(trimmed)) return false;
      if (APP_CHAT_URL_PATTERN.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function truncateLifecycleMessage(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isLettaCloudDatabaseLockErrorText(errorText: string): boolean {
  return (
    LETTA_CLOUD_DATABASE_LOCK_TIMEOUT_PATTERN.test(errorText) ||
    POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE_PATTERN.test(errorText) ||
    (POSTGRES_LOCK_NOT_AVAILABLE_CODE_PATTERN.test(errorText) &&
      POSTGRES_LOCK_NOT_AVAILABLE_CONTEXT_PATTERN.test(errorText))
  );
}

export function getChannelLifecycleErrorDisplay(
  errorText: string | null | undefined,
  options: ChannelLifecycleErrorDisplayOptions = {},
): ChannelLifecycleErrorDisplay {
  const normalized = sanitizeChannelLifecycleErrorText(errorText);
  const optionsRunId = options.runId?.trim();
  const runId = optionsRunId || extractChannelLifecycleRunId(errorText);

  if (!normalized || RAW_LOOP_ERROR_PATTERN.test(normalized)) {
    return {
      kind: "generic",
      title: "Turn failed",
      body: CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE,
      runId,
    };
  }

  if (isLettaCloudDatabaseLockErrorText(normalized)) {
    return {
      kind: "letta_cloud_busy",
      title: "Turn failed",
      body: CHANNEL_LIFECYCLE_LETTA_CLOUD_BUSY_MESSAGE,
      runId,
    };
  }

  if (isConversationBusyErrorText(normalized)) {
    return {
      kind: "conversation_busy",
      title: CHANNEL_LIFECYCLE_CONVERSATION_BUSY_TITLE,
      body: buildConversationBusyErrorBody(options.automaticRetry ?? false),
      runId,
    };
  }

  if (
    APPROVAL_PENDING_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return {
      kind: "approval_pending",
      title: "Turn failed",
      body: CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE,
      runId,
    };
  }

  return {
    kind: "generic",
    title: "Turn failed",
    body: normalized,
    runId,
  };
}

export function normalizeChannelLifecycleErrorMessage(
  errorText: string | null | undefined,
  options: ChannelLifecycleErrorDisplayOptions = {},
): string {
  return getChannelLifecycleErrorDisplay(errorText, options).body;
}

export function formatChannelLifecycleErrorMessage(
  errorText: string | null | undefined,
  options: ChannelLifecycleErrorFormatOptions = {},
): string {
  const display = getChannelLifecycleErrorDisplay(errorText, options);
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  const body = truncateLifecycleMessage(display.body, maxLength);

  if (display.kind === "conversation_busy") {
    const lines = [display.title, body];
    if (display.runId) {
      lines.push("", `Run ID: ${display.runId}`);
    }
    return lines.join("\n");
  }

  if (display.kind === "letta_cloud_busy") {
    const lines = [`${display.title}:`, body];
    if (display.runId) {
      lines.push("", `Run ID: ${display.runId}`);
    }
    return lines.join("\n");
  }

  if (options.codeBlock) {
    const escaped = body.replace(/```/g, "``\u200b`");
    const lines = [`${display.title}:`, "```", escaped, "```"];
    if (display.runId) {
      lines.push("", `Run ID: ${display.runId}`);
    }
    return lines.join("\n");
  }

  const lines = [`${display.title}:`, body];
  if (display.runId) {
    lines.push("", `Run ID: ${display.runId}`);
  }
  return lines.join("\n");
}
