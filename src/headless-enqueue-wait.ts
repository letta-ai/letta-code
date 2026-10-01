import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type {
  ConversationSendStatus,
  ConversationStatusEvent,
  EnqueueReceipt,
  LatestConversationSuperRun,
} from "@/backend/api/conversation-enqueue";

/** A send may span approval continuations. Only listener-published run IDs belong to it. */
export function getSendRunIds(
  status: ConversationSendStatus | null,
  clientMessageId: string,
): string[] {
  return Object.entries(
    status?.runtime_status?.loop_state?.client_message_ids_by_run_id ?? {},
  )
    .filter(([, ids]) => ids.includes(clientMessageId))
    .map(([runId]) => runId);
}

export function getConversationStatus(
  event: ConversationStatusEvent,
  conversationId: string,
): ConversationSendStatus | null | undefined {
  if (event.type === "conversation_super_run_snapshot") {
    return (
      event.statuses.find(
        (status) => status.conversation_id === conversationId,
      ) ?? null
    );
  }
  return event.conversation_id === conversationId ? event.status : undefined;
}

export interface EnqueuedReply {
  text: string;
  runIds: string[];
  stopReason: StopReasonType | null;
}

export class EnqueuedWaitError extends Error {
  constructor(
    error: unknown,
    readonly runIds: string[],
  ) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
    this.name = "EnqueuedWaitError";
  }
}

/**
 * Subscribe before enqueue so even a fast recipient cannot finish before we
 * see its run-to-message mapping. Stream loss is a waiting error, never a resend.
 */
export async function waitForEnqueuedReply(params: {
  receipt: EnqueueReceipt;
  events: AsyncIterator<ConversationStatusEvent>;
  firstEvent: ConversationStatusEvent;
  retrieveRun: (runId: string) => Promise<Run>;
  listRunMessages: (runId: string) => Promise<Message[]>;
  latestSuperRun: () => Promise<LatestConversationSuperRun | null>;
  signal: AbortSignal;
  pollMs?: number;
  now?: () => number;
}): Promise<EnqueuedReply> {
  const runIds = new Set<string>();
  const now = params.now ?? Date.now;
  let completedWithoutText: { runId: string; at: number } | undefined;
  let next: Promise<IteratorResult<ConversationStatusEvent>> = Promise.resolve({
    done: false,
    value: params.firstEvent,
  });
  try {
    while (true) {
      params.signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const event = await Promise.race([
        next,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), params.pollMs ?? 1_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (event) {
        if (event.done)
          throw new Error(
            "Conversation status connection closed; remote execution may still be running.",
          );
        const status = getConversationStatus(
          event.value,
          params.receipt.conversation_id,
        );
        if (status !== undefined) {
          for (const runId of getSendRunIds(
            status,
            params.receipt.client_message_id,
          ))
            runIds.add(runId);
        }
        next = params.events.next();
        // Keep a rejected read handled while the run/message HTTP requests run.
        void next.catch(() => {});
      }

      // Newest mapped run is the current approval continuation, never another
      // human turn selected by transcript position or role.
      const runId = [...runIds].at(-1);
      if (!runId) {
        const latest = await params.latestSuperRun();
        if (
          latest?.id === params.receipt.super_run_id &&
          (latest.errored_at || latest.cancelled_at)
        ) {
          throw new Error(
            `Accepted send ${latest.id} ${latest.errored_at ? "failed" : "was cancelled"} before a run was observed.`,
          );
        }
        continue;
      }
      const run = await params.retrieveRun(runId);
      if (run.status === "failed" || run.status === "cancelled") {
        throw new Error(
          `Remote run ${runId} ${run.status}${run.stop_reason ? ` (${run.stop_reason})` : ""}`,
        );
      }
      if (run.status !== "completed" || run.stop_reason === "requires_approval")
        continue;
      const messages = await params.listRunMessages(runId);
      const assistant = messages
        .filter((message) => message.message_type === "assistant_message")
        .sort((a, b) => (b.seq_id ?? 0) - (a.seq_id ?? 0))[0];
      if (assistant?.message_type === "assistant_message") {
        const text =
          typeof assistant.content === "string"
            ? assistant.content
            : assistant.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        if (text.trim())
          return {
            text,
            runIds: [...runIds],
            stopReason: run.stop_reason ?? null,
          };
      }
      if (completedWithoutText?.runId !== runId)
        completedWithoutText = { runId, at: now() };
      // Run status and messages can become visible on different reads.
      if (now() - completedWithoutText.at < 15_000) continue;
      throw new Error(
        `Remote run ${runId} completed without an assistant reply (${run.stop_reason ?? "unknown stop reason"})`,
      );
    }
  } catch (error) {
    throw new EnqueuedWaitError(error, [...runIds]);
  }
}
