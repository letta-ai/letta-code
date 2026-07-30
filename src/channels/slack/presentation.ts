import { isLocalAgentId } from "@/agent/agent-id";
import { normalizeChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import { truncateChannelProgressText } from "@/channels/progress-formatting";
import type { ChannelControlRequestEvent } from "@/channels/types";
import type { SlackApprovalActionPayload, SlackBlock } from "./internal-types";

export {
  formatSlackToolNameForDisplay,
  resolveSlackConcreteActivity,
  SLACK_ASSISTANT_STARTUP_STATUS,
  SLACK_ASSISTANT_WORKING_STATUS,
  sanitizeSlackStatusText,
} from "./progress";

import {
  formatSlackToolNameForDisplay,
  sanitizeSlackStatusText,
} from "./progress";
import { isNonEmptyString } from "./utils";
export const SLACK_APPROVAL_ACTION_ID = "letta_channel_approval";

const SLACK_MARKDOWN_BLOCK_TEXT_MAX = 12_000;
const SLACK_SECTION_BLOCK_TEXT_MAX = 3_000;
const SLACK_LIFECYCLE_ERROR_TEXT_MAX = 3_000;
const SLACK_SCHEDULED_PROMPT_PREVIEW_MAX = 360;
const SLACK_SCHEDULED_PROMPT_LABEL = "*Full scheduled prompt:*\n";
const CRON_PROMPT_AUTONOMOUS_NOTICE =
  "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked.";

type ParsedSlackCronPrompt = {
  taskName: string;
  description?: string;
  scheduledFor: string;
  recurrence: string;
  prompt: string;
};

function compactSlackPreviewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeSlackMrkdwnText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSlackInlineCode(text: string): string {
  return `\`${escapeSlackMrkdwnText(text).replace(/`/g, "'")}\``;
}

function splitEscapedSlackMrkdwnText(
  text: string,
  maxLength: number,
): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of text) {
    const escaped = escapeSlackMrkdwnText(char);
    if (chunk && chunk.length + escaped.length > maxLength) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += escaped;
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
}

function getCronPromptField(
  lines: string[],
  prefix: string,
): string | undefined {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value ? value : undefined;
}

function formatCronPromptRecurrence(line: string): string | null {
  const recurring = /^This is fire #(\d+) \(cron: (.+)\)\.$/.exec(line);
  if (recurring) {
    return `Fire #${recurring[1]} · cron ${formatSlackInlineCode(recurring[2] ?? "")}`;
  }
  if (line === "This is a one-off scheduled task.") {
    return "One-off scheduled task";
  }
  return null;
}

function parseSlackCronPrompt(text: string): ParsedSlackCronPrompt | null {
  const normalized = text.trim();
  const promptMarker = "\nPrompt: ";
  const promptIndex = normalized.indexOf(promptMarker);
  if (promptIndex < 0) return null;

  const header = normalized.slice(0, promptIndex);
  const prompt = normalized.slice(promptIndex + promptMarker.length).trim();
  if (!prompt || !header.includes(CRON_PROMPT_AUTONOMOUS_NOTICE)) {
    return null;
  }

  const lines = header.split(/\r?\n/).map((line) => line.trim());
  const titleMatch = /^Scheduled task "(.+)" is firing\.$/.exec(lines[0] ?? "");
  if (!titleMatch) return null;

  const scheduledFor = getCronPromptField(lines, "Scheduled for:");
  const currentTime = getCronPromptField(lines, "Current time:");
  const recurrenceLine = lines.find((line) =>
    /^(This is fire #\d+ \(cron: .+\)\.|This is a one-off scheduled task\.)$/.test(
      line,
    ),
  );
  const recurrence = recurrenceLine
    ? formatCronPromptRecurrence(recurrenceLine)
    : null;
  if (!scheduledFor || !currentTime || !recurrence) return null;

  return {
    taskName: titleMatch[1] ?? "scheduled task",
    description: getCronPromptField(lines, "Description:"),
    scheduledFor,
    recurrence,
    prompt,
  };
}

function extractSlackFootnoteUrl(footnote: string): string | null {
  const match = /^<([^|>]+)\|[^>]+>$/.exec(footnote.trim());
  return match?.[1] ?? null;
}

function formatSlackCronPromptFallback(parsed: ParsedSlackCronPrompt): string {
  const promptPreview = truncateChannelProgressText(
    compactSlackPreviewText(parsed.prompt),
    SLACK_SCHEDULED_PROMPT_PREVIEW_MAX,
    "...",
  );
  return [
    `Scheduled task fired: ${parsed.taskName}`,
    parsed.recurrence.replace(/`/g, ""),
    `Scheduled for: ${parsed.scheduledFor}`,
    `Prompt: ${promptPreview}`,
  ].join("\n");
}

function buildSlackCronPromptBlocks(
  text: string,
  footnote: string,
): SlackBlock[] | null {
  const parsed = parseSlackCronPrompt(text);
  if (!parsed) return null;

  const descriptionPreview = parsed.description
    ? truncateChannelProgressText(
        compactSlackPreviewText(parsed.description),
        180,
        "...",
      )
    : "";
  const summaryLines = [
    `:calendar: *Scheduled task fired*`,
    `*${escapeSlackMrkdwnText(parsed.taskName)}*`,
    descriptionPreview ? escapeSlackMrkdwnText(descriptionPreview) : null,
    parsed.recurrence,
    `:clock1: Scheduled for ${formatSlackInlineCode(parsed.scheduledFor)}`,
  ].filter((line): line is string => Boolean(line));

  const promptChunks = splitEscapedSlackMrkdwnText(
    parsed.prompt,
    SLACK_SECTION_BLOCK_TEXT_MAX - SLACK_SCHEDULED_PROMPT_LABEL.length,
  );
  const blocks: SlackBlock[] = [
    {
      type: "section",
      expand: false,
      text: {
        type: "mrkdwn",
        text: truncateChannelProgressText(
          summaryLines.join("\n"),
          SLACK_SECTION_BLOCK_TEXT_MAX,
          "...",
        ),
      },
    },
    ...promptChunks.map(
      (chunk, index): SlackBlock => ({
        type: "section",
        expand: false,
        text: {
          type: "mrkdwn",
          text: index === 0 ? `${SLACK_SCHEDULED_PROMPT_LABEL}${chunk}` : chunk,
        },
      }),
    ),
  ];

  const footnoteUrl = extractSlackFootnoteUrl(footnote);
  if (footnoteUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${footnoteUrl}|View full scheduled prompt>`,
        },
      ],
    });
  } else if (footnote.trim()) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: footnote }],
    });
  }

  return blocks;
}

function buildSlackChatUrl(
  agentId: string,
  conversationId: string,
): string | undefined {
  if (isLocalAgentId(agentId)) {
    return undefined;
  }
  const base = `https://chat.letta.com/chat/${agentId}`;
  return conversationId && conversationId !== "default"
    ? `${base}?conversation=${conversationId}`
    : base;
}

export function buildSlackChatFootnote(identity: {
  agentId: string;
  conversationId: string;
}): string {
  const chatUrl = buildSlackChatUrl(identity.agentId, identity.conversationId);
  return chatUrl ? `<${chatUrl}|View on web>` : "";
}

export function formatSlackReplyTextFallback(text: string): string {
  const parsed = parseSlackCronPrompt(text);
  return parsed ? formatSlackCronPromptFallback(parsed) : text;
}

export function buildSlackReplyBlocksWithFootnote(
  text: string,
  footnote: string,
): SlackBlock[] | undefined {
  const cronPromptBlocks = buildSlackCronPromptBlocks(text, footnote);
  if (cronPromptBlocks) {
    return cronPromptBlocks;
  }
  if (!footnote.trim()) {
    return undefined;
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MARKDOWN_BLOCK_TEXT_MAX) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", SLACK_MARKDOWN_BLOCK_TEXT_MAX);
    if (cut <= 0) {
      cut = remaining.lastIndexOf(" ", SLACK_MARKDOWN_BLOCK_TEXT_MAX);
    }
    if (cut <= 0) {
      cut = SLACK_MARKDOWN_BLOCK_TEXT_MAX;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  const markdownChunks = chunks.filter((chunk) => chunk.trim().length > 0);
  if (markdownChunks.length === 0 || markdownChunks.length > 49) {
    return undefined;
  }
  const blocks: SlackBlock[] = markdownChunks.map((chunk) => ({
    type: "markdown",
    text: chunk,
  }));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footnote }],
  });
  return blocks;
}

export function formatSlackControlRequestBlocks(
  event: ChannelControlRequestEvent,
): SlackBlock[] | undefined {
  if (event.kind !== "generic_tool_approval") {
    return undefined;
  }
  const toolName =
    sanitizeSlackStatusText(
      formatSlackToolNameForDisplay(event.toolName),
      80,
    ) || "tool";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed*\nRun \`${toolName}\`?`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_APPROVAL_ACTION_ID,
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          value: JSON.stringify({
            requestId: event.requestId,
            decision: "allow",
          } satisfies SlackApprovalActionPayload),
        },
        {
          type: "button",
          action_id: SLACK_APPROVAL_ACTION_ID,
          text: { type: "plain_text", text: "Deny", emoji: true },
          style: "danger",
          value: JSON.stringify({
            requestId: event.requestId,
            decision: "deny",
          } satisfies SlackApprovalActionPayload),
        },
      ],
    },
  ];
}

export function parseSlackApprovalActionPayload(
  value: unknown,
): { requestId: string; decision: "allow" | "deny" } | null {
  if (!isNonEmptyString(value)) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as SlackApprovalActionPayload;
    if (
      !isNonEmptyString(parsed.requestId) ||
      (parsed.decision !== "allow" && parsed.decision !== "deny")
    ) {
      return null;
    }
    return { requestId: parsed.requestId, decision: parsed.decision };
  } catch {
    return null;
  }
}

export function buildSlackApprovalDecisionBlocks(text: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];
}

export function shouldPostSlackTerminalError(stopReason: string): boolean {
  return !["end_turn", "cancelled", "requires_approval", "tool_rule"].includes(
    stopReason,
  );
}

export function formatSlackLifecycleErrorMessage(errorText: string): string {
  return truncateChannelProgressText(
    normalizeChannelLifecycleErrorMessage(errorText),
    SLACK_LIFECYCLE_ERROR_TEXT_MAX,
    "...",
  );
}
