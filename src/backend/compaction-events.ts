export type ConversationCompaction = {
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
