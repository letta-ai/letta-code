import { setTimeout as delay } from "node:timers/promises";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  AcceptedSuperRun,
  EnqueueReceipt,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import type { EnqueuedReply } from "@/headless-enqueue-wait";

export interface SuperRunWaitDeps {
  retrieve: (
    receipt: EnqueueReceipt,
    signal: AbortSignal,
  ) => Promise<AcceptedSuperRun>;
  messages: (runId: string, signal: AbortSignal) => Promise<Message[]>;
  pollMs?: number;
  now?: () => number;
}

/** Poll one accepted send. Losing a read never resubmits work or fails its execution. */
export async function waitForAcceptedSuperRun(
  receipt: EnqueueReceipt,
  signal: AbortSignal,
  deps: SuperRunWaitDeps,
): Promise<EnqueuedReply> {
  let terminalWithoutResultAt: number | undefined;
  let failures = 0;
  const now = deps.now ?? Date.now;
  while (true) {
    signal.throwIfAborted();
    let state: AcceptedSuperRun;
    let messages: Message[] = [];
    try {
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      state = await deps.retrieve(receipt, readSignal);
      // Core runs may fail and be replaced during listener recovery. Only the
      // accepted Super Run and the listener's final outcome decide completion.
      if (
        state.completed_at &&
        state.turn_finished?.stop_reason === "end_turn"
      ) {
        messages = await deps.messages(state.turn_finished.run_id, readSignal);
      }
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof ApiRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      )
        throw error;
      if (
        error instanceof Error &&
        error.message.startsWith("Cloud does not support exact")
      )
        throw error;
      failures++;
      await delay(
        Math.min(
          30_000,
          (deps.pollMs ?? 1000) * 2 ** Math.min(failures - 1, 5),
        ),
        undefined,
        { signal },
      );
      continue;
    }
    if (state.cancelled_at || state.errored_at) {
      throw new Error(
        `Remote Super Run ${receipt.super_run_id} ${state.cancelled_at ? "was cancelled" : "failed"}`,
      );
    }
    if (state.completed_at) {
      const outcome = state.turn_finished;
      if (outcome && outcome.stop_reason !== "end_turn") {
        throw new Error(
          outcome.error ||
            `Remote listener turn stopped (${outcome.stop_reason})`,
        );
      }
      const last = messages
        .filter((m) => m.message_type === "assistant_message")
        .sort((a, b) => (b.seq_id ?? 0) - (a.seq_id ?? 0))[0];
      if (last?.message_type === "assistant_message") {
        const text =
          typeof last.content === "string"
            ? last.content
            : last.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        if (text.trim())
          return { text, runIds: state.run_ids, stopReason: "end_turn" };
      }
      terminalWithoutResultAt ??= now();
      if (now() - terminalWithoutResultAt >= 30_000) {
        throw new Error(
          `Remote Super Run ${receipt.super_run_id} completed, but its listener outcome or reply is unavailable. Do not resend the task.`,
        );
      }
    }
    await delay(deps.pollMs ?? 5_000, undefined, { signal });
  }
}
