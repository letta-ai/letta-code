import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";

export interface PreparedSubagent {
  agentId: string;
  conversationId: string;
}

export interface SubagentSetup {
  /** Trusted caller replacement for Agent's generic one-task fork reminder. */
  firstTurnReminder?: string;
  onInputAccepted?(receipt: EnqueueReceipt): Promise<void>;
  /** Runs after the child exists and before its first task is started. */
  beforeStart(
    child: PreparedSubagent,
  ): Promise<
    | { start: true; clientMessageId?: string }
    | { start: false; result: string; discardUnstartedFork: boolean }
  >;
}

/** Unknown setup outcomes retain the child: it may already be durably bound.
 * Only an explicit losing-fork receipt authorizes deleting this new child.
 */
export async function runSubagentSetup(params: {
  child: PreparedSubagent;
  setup: SubagentSetup;
  signal?: AbortSignal;
  deleteUnstartedFork: (conversationId: string) => Promise<unknown>;
}): Promise<
  { start: true; clientMessageId?: string } | { start: false; result: string }
> {
  params.signal?.throwIfAborted();
  const result = await params.setup.beforeStart(params.child);
  if (!result.start) {
    if (result.discardUnstartedFork)
      await params.deleteUnstartedFork(params.child.conversationId);
    return { start: false, result: result.result };
  }
  params.signal?.throwIfAborted();
  return result;
}

export function createInputAcceptanceWaiter(
  clientMessageId: string,
  onInputAccepted: (receipt: EnqueueReceipt) => Promise<void>,
) {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let accepted = false;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void ready.catch(() => {});
  return {
    ready,
    async wait(signal?: AbortSignal) {
      const deadline = AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(signal ? [signal] : []),
      ]);
      deadline.throwIfAborted();
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, fail) => {
            abort = () =>
              fail(
                new Error(
                  "Initial input acceptance is unknown; verify the existing worker before retrying",
                ),
              );
            deadline.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        if (abort) deadline.removeEventListener("abort", abort);
      }
    },
    acceptance: {
      clientMessageId,
      async onInputAccepted(receipt: EnqueueReceipt) {
        try {
          if (receipt.client_message_id !== clientMessageId)
            throw new Error("Agent accepted a different initial input");
          await onInputAccepted(receipt);
          accepted = true;
          resolve();
        } catch (error) {
          reject(error);
          throw error;
        }
      },
    },
    completed(error?: string) {
      if (!accepted)
        reject(
          new Error(
            error ??
              "Agent finished without an initial enqueue receipt; acceptance is unknown",
          ),
        );
    },
  };
}
