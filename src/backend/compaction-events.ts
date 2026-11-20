/**
 * Process-local notifications for completed conversation compactions.
 *
 * A compaction rewrites a conversation's history, so harness state that was
 * tuned to the old prompt (for example the frozen `client_skills` baseline)
 * should reset. Backends report compactions they can see: a manual compact
 * request, or a `summary_message` on a stream they open. Higher layers
 * subscribe without the backend depending on them.
 */

export type ConversationCompaction = {
  /** The backend instance that observed the compaction. */
  backend: object;
  conversationId: string;
  agentId?: string | null;
};

type CompactionListener = (compaction: ConversationCompaction) => void;

const listeners = new Set<CompactionListener>();

export function onConversationCompacted(
  listener: CompactionListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyConversationCompacted(
  compaction: ConversationCompaction,
): void {
  for (const listener of listeners) listener(compaction);
}

export function isCompactionSummaryChunk(chunk: unknown): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as { message_type?: unknown }).message_type === "summary_message"
  );
}

/**
 * Report a `summary_message` seen on `stream` as a compaction of the given
 * conversation. Mutates and returns the same stream object so SDK stream
 * helpers (controller, abort relays) keep working.
 */
export function tapConversationCompaction<T extends AsyncIterable<unknown>>(
  stream: T,
  compaction: ConversationCompaction,
): T {
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[
    Symbol.asyncIterator
  ] = () => {
    const iterator = originalAsyncIterator();
    return {
      async next() {
        const result = await iterator.next();
        if (!result.done && isCompactionSummaryChunk(result.value)) {
          notifyConversationCompacted(compaction);
        }
        return result;
      },
      return: (value?: unknown) =>
        iterator.return
          ? iterator.return(value)
          : Promise.resolve({ done: true as const, value }),
      throw: (error?: unknown) =>
        iterator.throw ? iterator.throw(error) : Promise.reject(error),
    };
  };
  return stream;
}
