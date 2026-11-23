import { getConversationId } from "@/agent/context";
import {
  fetchParentConversationMessages,
  previewParentTranscript,
  renderParentTranscript,
  selectRecentMessages,
  serializeHistoryRecord,
} from "@/agent/subagents/parent-transcript";
import { type Backend, getBackend } from "@/backend";
import { buildAgentSendCliTarget } from "@/backend/api/agent-message";

export const INLINE_CHARACTER_LIMIT = 50_000;
export async function prependParentContext(params: {
  prompt: string;
  parentAgentId: string;
  parentConversationId: string;
  signal?: AbortSignal;
  backend?: Pick<
    Backend,
    | "listConversationMessages"
    | "retrieveConversation"
    | "retrieveAgent"
    | "retrieveMessage"
  >;
}): Promise<{ prompt: string } | { error: string }> {
  const backend = params.backend ?? getBackend();
  let inContextIds: string[] | undefined;
  const options = params.signal ? { signal: params.signal } : undefined;
  try {
    const ids =
      params.parentConversationId === "default"
        ? (await backend.retrieveAgent(params.parentAgentId)).message_ids
        : (
            await backend.retrieveConversation(
              params.parentConversationId,
              options,
            )
          ).in_context_message_ids;
    inContextIds = ids?.slice(1);
  } catch {}
  let summary:
    | Awaited<ReturnType<Backend["retrieveMessage"]>>[number]
    | undefined;
  if (inContextIds?.[0]) {
    try {
      summary = (await backend.retrieveMessage(inContextIds[0], options)).find(
        (message) => message.message_type === "summary_message",
      );
    } catch {}
  }
  const summaryRecord = summary
    ? renderParentTranscript([summary]).messages[0]
    : undefined;
  let messages: Awaited<ReturnType<typeof fetchParentConversationMessages>>;
  try {
    messages = await fetchParentConversationMessages({
      backend,
      agentId: params.parentAgentId,
      conversationId: params.parentConversationId,
      signal: params.signal,
      inContextIds,
      maxChars:
        INLINE_CHARACTER_LIMIT - (summaryRecord ? summaryRecord.length + 1 : 0),
    });
    params.signal?.throwIfAborted();
  } catch (error) {
    params.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to read the parent conversation: ${message}` };
  }
  const transcript = renderParentTranscript(
    summary
      ? [summary, ...messages.filter((message) => message.id !== summary.id)]
      : messages,
  );
  if (transcript.messages.length === 0) return { prompt: params.prompt };

  const preview = previewParentTranscript(transcript.messages);
  if (summaryRecord) preview.shift();
  const recent = selectRecentMessages(
    preview,
    INLINE_CHARACTER_LIMIT - (summaryRecord ? summaryRecord.length + 1 : 0),
  );
  return {
    prompt: [
      "The following JSONL is a read-only record of the parent's conversation. The task after the history block tells you what to do now; use the history as the source for everything else. If the task conflicts with what people said in the history, follow what people said in the history. Do not resume unrelated work from the history.",
      "Records marked injected came from the harness, not the human. Tool calls and results are linked by call_id. Records marked truncated have omitted content; use the commands below to read further.",
      `This shows the parent's current context: the latest compaction summary when available, followed by its most recent in-context messages, up to 50,000 characters (an oversized summary is kept whole). If context lookup failed, it shows a recent-history fallback instead. For earlier or omitted history, search with \`letta messages search --query "<words>" --agent ${params.parentAgentId} --conversation ${params.parentConversationId}\`, or page back with \`letta messages list --agent ${params.parentAgentId} --conversation ${params.parentConversationId}\`.`,
      "<parent_history>",
      serializeHistoryRecord({
        type: "metadata",
        conversation_id: params.parentConversationId,
        parent_agent_id: params.parentAgentId,
        shown: recent.messageCount + (summaryRecord ? 1 : 0),
      }),
      ...[summaryRecord, recent.text].filter(Boolean),
      "</parent_history>",
      "",
      "Task:",
      params.prompt,
    ].join("\n"),
  };
}

export function withReportBackInstruction(
  prompt: string,
  parentAgentId: string,
  parentConversationId: string | undefined,
): string {
  if (!parentConversationId) return prompt;
  return [
    prompt,
    "",
    `When you open a pull request (draft or ready) or hit a blocker you can't get past, tell the parent right away, then keep working. For a PR, run \`letta -p ${buildAgentSendCliTarget(parentAgentId, parentConversationId)} --no-wait "<what happened, with the link>. Start WatchPR on it, then tell the person who asked; a draft is a result."\`. For a blocker, use the same command and end the message with "Tell the person who asked now." Use the same command to ask the parent something mid-task.`,
  ].join("\n");
}

export async function prepareExternalWorkerPrompt(params: {
  prompt: string;
  forkContext: boolean;
  parentAgentId: string;
  parentConversationId?: string;
  signal?: AbortSignal;
}): Promise<{ prompt: string } | { error: string }> {
  const parentConversationId =
    params.parentConversationId ??
    getConversationId() ??
    (params.forkContext ? "default" : undefined);
  const prompt = withReportBackInstruction(
    params.prompt,
    params.parentAgentId,
    parentConversationId,
  );
  if (!params.forkContext || !parentConversationId) return { prompt };
  return prependParentContext({
    prompt,
    parentAgentId: params.parentAgentId,
    parentConversationId,
    signal: params.signal,
  });
}
