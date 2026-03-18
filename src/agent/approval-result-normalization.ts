import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { INTERRUPTED_BY_USER } from "../constants";
import type { ApprovalResult } from "./approval-execution";

type OutgoingMessage = MessageCreate | ApprovalCreate;
type ToolReturnContent = Extract<
  ApprovalResult,
  { type: "tool" }
>["tool_return"];

export type ApprovalNormalizationOptions = {
  /**
   * Structured interrupt provenance: tool_call_ids known to have been interrupted.
   * When provided, these IDs are forced to persist as status=error.
   */
  interruptedToolCallIds?: Iterable<string>;
  /**
   * Temporary fallback guard for legacy drift where tool_return text is the only
   * interrupt signal. Keep false by default for strict structured behavior.
   */
  allowInterruptTextFallback?: boolean;
};

function normalizeToolReturnText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    const text = value
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type?: unknown }).type === "text" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text;
  }

  if (value === null || value === undefined) return "";

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isToolReturnContent(value: unknown): value is ToolReturnContent {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;

  return value.every(
    (part) =>
      !!part &&
      typeof part === "object" &&
      "type" in part &&
      (((part as { type?: unknown }).type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string") ||
        ((part as { type?: unknown }).type === "image" &&
          "data" in part &&
          typeof (part as { data?: unknown }).data === "string" &&
          "mimeType" in part &&
          typeof (part as { mimeType?: unknown }).mimeType === "string")),
  );
}

export function normalizeApprovalResultsForPersistence(
  approvals: ApprovalResult[] | null | undefined,
  options: ApprovalNormalizationOptions = {},
): ApprovalResult[] {
  if (!approvals || approvals.length === 0) return approvals ?? [];

  const interruptedSet = new Set(options.interruptedToolCallIds ?? []);

  return approvals.map((approval) => {
    if (
      approval &&
      typeof approval === "object" &&
      "type" in approval &&
      approval.type === "approval" &&
      "approve" in approval &&
      approval.approve === true &&
      "tool_return" in approval &&
      isToolReturnContent(approval.tool_return)
    ) {
      return {
        type: "tool",
        tool_call_id:
          "tool_call_id" in approval &&
          typeof approval.tool_call_id === "string"
            ? approval.tool_call_id
            : "",
        tool_return: approval.tool_return,
        status:
          "status" in approval && approval.status === "error"
            ? "error"
            : "success",
        stdout:
          "stdout" in approval && Array.isArray(approval.stdout)
            ? approval.stdout
            : undefined,
        stderr:
          "stderr" in approval && Array.isArray(approval.stderr)
            ? approval.stderr
            : undefined,
      } satisfies ApprovalResult;
    }

    if (
      !approval ||
      typeof approval !== "object" ||
      !("type" in approval) ||
      approval.type !== "tool"
    ) {
      return approval;
    }

    const toolCallId =
      "tool_call_id" in approval && typeof approval.tool_call_id === "string"
        ? approval.tool_call_id
        : "";

    const interruptedByStructuredId =
      toolCallId.length > 0 && interruptedSet.has(toolCallId);
    const interruptedByLegacyText = options.allowInterruptTextFallback
      ? normalizeToolReturnText(
          "tool_return" in approval ? approval.tool_return : "",
        ) === INTERRUPTED_BY_USER
      : false;

    if (
      (interruptedByStructuredId || interruptedByLegacyText) &&
      "status" in approval &&
      approval.status !== "error"
    ) {
      return {
        ...approval,
        status: "error" as const,
      };
    }

    return approval;
  });
}

export function normalizeOutgoingApprovalMessages(
  messages: OutgoingMessage[],
  options: ApprovalNormalizationOptions = {},
): OutgoingMessage[] {
  if (!messages || messages.length === 0) return messages;

  return messages.map((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      message.type !== "approval" ||
      !("approvals" in message)
    ) {
      return message;
    }

    const normalizedApprovals = normalizeApprovalResultsForPersistence(
      message.approvals as ApprovalResult[],
      options,
    );

    return {
      ...message,
      approvals: normalizedApprovals,
    } as ApprovalCreate;
  });
}
