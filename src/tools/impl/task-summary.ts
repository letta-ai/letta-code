import { type Backend, getBackend } from "@/backend";

/**
 * Record the task description as a new subagent conversation's summary, so
 * conversation lists show which task each subagent owns. Callers skip resumed
 * conversations, which keep their own summary. Best effort: a failed write
 * never fails the launch.
 */
export function recordTaskSummary(
  conversationId: string | null | undefined,
  description: string,
  backend?: Pick<Backend, "updateConversation">,
): Promise<void> {
  const summary = description.trim();
  if (!conversationId || conversationId === "default" || !summary) {
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() =>
      (backend ?? getBackend()).updateConversation(conversationId, { summary }),
    )
    .then(() => undefined)
    .catch(() => undefined);
}

/** A forked worker without a prompt takes its task description as the assignment. */
export function resolveTaskInput(
  args: { prompt?: unknown; description?: unknown },
  forked: boolean,
): { description: string; prompt: string } | { error: string } {
  const { prompt, description } = args;
  if (typeof description !== "string" || !description.trim()) {
    return { error: "description is required" };
  }
  if (typeof prompt === "string" && prompt.trim()) {
    return { description, prompt };
  }
  if (forked) return { description, prompt: description };
  return {
    error:
      "prompt is required unless the agent forks this conversation (fork_context)",
  };
}
