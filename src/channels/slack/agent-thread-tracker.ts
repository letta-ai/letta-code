const SLACK_AGENT_THREAD_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_AGENT_THREAD_MAX = 2_000;

export type AgentThreadTracker = {
  remember: (channelId: string, threadId: string) => void;
  has: (channelId: string, threadId: string) => boolean;
  clear: () => void;
};

type AgentThreadTrackerOptions = {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

function buildKey(channelId: string, threadId: string): string {
  return `${channelId}:${threadId}`;
}

export function createAgentThreadTracker(
  options: AgentThreadTrackerOptions = {},
): AgentThreadTracker {
  const threadIds = new Map<string, number>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SLACK_AGENT_THREAD_TTL_MS;
  const maxEntries = options.maxEntries ?? SLACK_AGENT_THREAD_MAX;

  function prune(currentTime: number = now()): void {
    for (const [key, expiresAt] of threadIds) {
      if (expiresAt <= currentTime) {
        threadIds.delete(key);
      }
    }
    if (threadIds.size <= maxEntries) {
      return;
    }
    const sorted = Array.from(threadIds.entries()).sort((a, b) => a[1] - b[1]);
    const overflow = threadIds.size - maxEntries;
    for (let index = 0; index < overflow; index += 1) {
      const entry = sorted[index];
      if (entry) {
        threadIds.delete(entry[0]);
      }
    }
  }

  return {
    remember(channelId, threadId): void {
      const currentTime = now();
      prune(currentTime);
      threadIds.set(buildKey(channelId, threadId), currentTime + ttlMs);
    },
    has(channelId, threadId): boolean {
      prune();
      return threadIds.has(buildKey(channelId, threadId));
    },
    clear(): void {
      threadIds.clear();
    },
  };
}
