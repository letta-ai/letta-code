import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "@/agent/approval-execution";
import type { Buffers } from "@/cli/helpers/accumulator";
import {
  buildQueuedContentParts,
  buildQueuedUserText,
} from "@/cli/helpers/queued-message-parts";
import { tuiQueuedClientPreferences } from "@/cli/helpers/tui-client-preferences";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { appendOptimisticUserLine, createClientOtid } from "./ids";
import type { ProcessConversation, ProcessConversationOptions } from "./types";

/** Command and ordinary submits use the origin selected by their caller. */
export function bindTuiClientPreferences(
  processConversation: ProcessConversation,
  clientPreferences: ProcessConversationOptions["clientPreferences"],
): ProcessConversation {
  return (input, options) =>
    processConversation(input, { ...options, clientPreferences });
}

/** Tool results must precede the new user message, including interrupt recovery. */
export function buildTuiTurnInput({
  content,
  otid,
  approvals,
  queuedApproval,
}: {
  content?: MessageCreate["content"];
  otid?: string;
  approvals?: ApprovalResult[] | null;
  queuedApproval?: ApprovalCreate | null;
}): Array<MessageCreate | ApprovalCreate> {
  const input: Array<MessageCreate | ApprovalCreate> = [];
  if (approvals?.length) {
    input.push({ type: "approval", approvals, otid: createClientOtid() });
  }
  if (queuedApproval) input.push(queuedApproval);
  if (content !== undefined) {
    input.push({ type: "message", role: "user", content, otid });
  }
  return input;
}

/** Prepare the same queued continuation for manual and auto-approved tools. */
export function prepareTuiQueuedTurn(
  items: QueuedMessage[] | null,
  approvals: ApprovalResult[],
  buffers: Buffers,
) {
  const hasQueuedMessage = Boolean(items?.length);
  const otid = createClientOtid();
  if (items?.length) {
    appendOptimisticUserLine(buffers, buildQueuedUserText(items), otid);
  }
  return {
    input: buildTuiTurnInput({
      content: items?.length ? buildQueuedContentParts(items) : undefined,
      otid,
      approvals,
    }),
    options: {
      allowReentry: true,
      clientPreferences: tuiQueuedClientPreferences(items),
    },
    hasQueuedMessage,
  };
}
