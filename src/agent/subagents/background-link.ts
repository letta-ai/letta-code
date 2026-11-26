import { getSnapshot as getSubagentSnapshot } from "@/agent/subagent-state";
import { sleep } from "@/utils/sleep";

const BACKGROUND_STARTUP_POLL_MS = 50;

function deadlineFor(timeoutMs: number | null): number | null {
  return timeoutMs !== null && timeoutMs > 0 ? Date.now() + timeoutMs : null;
}

function deadlineReached(deadline: number | null): boolean {
  return deadline !== null && Date.now() >= deadline;
}

export function waitForBackgroundSubagentLink(
  subagentId: string,
  timeoutMs: number | null = null,
  signal?: AbortSignal,
): Promise<string | null> {
  return waitForBackgroundSubagentConversationId(subagentId, timeoutMs, signal);
}

export async function waitForBackgroundSubagentAgentId(
  subagentId: string,
  timeoutMs: number | null = null,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = deadlineFor(timeoutMs);
  while (!signal?.aborted) {
    const agent = getSubagentSnapshot().agents.find(
      (entry) => entry.id === subagentId,
    );
    if (!agent) return null;
    if (
      agent.agentId ||
      agent.status === "error" ||
      agent.status === "completed" ||
      deadlineReached(deadline)
    ) {
      return agent.agentId ?? null;
    }
    await sleep(BACKGROUND_STARTUP_POLL_MS);
  }
  return null;
}

export async function waitForBackgroundSubagentConversationId(
  subagentId: string,
  timeoutMs: number | null = null,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = deadlineFor(timeoutMs);
  while (!signal?.aborted) {
    const agent = getSubagentSnapshot().agents.find(
      (entry) => entry.id === subagentId,
    );
    if (!agent) return null;
    if (
      agent.conversationId ||
      agent.status === "error" ||
      agent.status === "completed" ||
      deadlineReached(deadline)
    ) {
      return agent.conversationId ?? null;
    }
    await sleep(BACKGROUND_STARTUP_POLL_MS);
  }
  return null;
}
