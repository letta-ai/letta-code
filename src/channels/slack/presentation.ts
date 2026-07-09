import { isLocalAgentId } from "@/agent/agent-id";
import { normalizeChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import {
  sanitizeChannelProgressCore,
  truncateChannelProgressText,
} from "@/channels/progress";
import type {
  ChannelControlRequestEvent,
  ChannelTurnProgressEvent,
} from "@/channels/types";
import {
  getDisplayToolName,
  isShellTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping";
import type { SlackApprovalActionPayload, SlackBlock } from "./internal-types";
import { isNonEmptyString } from "./utils";

export const SLACK_ASSISTANT_STARTUP_STATUS = "is thinking...";
export const SLACK_ASSISTANT_WORKING_STATUS = "is working...";
export const SLACK_APPROVAL_ACTION_ID = "letta_channel_approval";

const SLACK_MARKDOWN_BLOCK_TEXT_MAX = 12_000;
const SLACK_LIFECYCLE_ERROR_TEXT_MAX = 3_000;
const SLACK_STATUS_TEXT_MAX = 300;

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

export function buildSlackReplyBlocksWithFootnote(
  text: string,
  footnote: string,
): SlackBlock[] | undefined {
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

function sanitizeSlackStatusText(text: string, maxLength: number): string {
  const normalized = sanitizeChannelProgressCore(text)
    .replace(/[<>]/g, "")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
  return truncateChannelProgressText(normalized, maxLength, "...");
}

function formatSlackToolNameForDisplay(toolName: string): string {
  return isTaskTool(toolName) ? "Subagent" : getDisplayToolName(toolName);
}

export function resolveSlackConcreteActivity(
  event: ChannelTurnProgressEvent,
): string | null {
  if (event.kind === "command" && isNonEmptyString(event.command)) {
    return sanitizeSlackStatusText(
      formatSlackToolNameForDisplay(event.command),
      SLACK_STATUS_TEXT_MAX,
    );
  }
  if (
    event.kind !== "tool" ||
    !isNonEmptyString(event.toolName) ||
    event.toolName.toLowerCase() === "messagechannel"
  ) {
    return null;
  }

  for (const description of [
    event.toolTitle,
    event.toolDetails,
    isShellTool(event.toolName) ? event.message : undefined,
    formatSlackToolNameForDisplay(event.toolName),
  ]) {
    if (!isNonEmptyString(description)) {
      continue;
    }
    const sanitized = sanitizeSlackStatusText(
      description,
      SLACK_STATUS_TEXT_MAX,
    );
    if (sanitized) {
      return sanitized;
    }
  }
  return null;
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
