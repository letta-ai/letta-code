// Foreground Agent calls for subagents. Kept apart from task.ts, which passes
// its launcher in, so this module has no import back into the Agent tool.

import { getCurrentWorkingDirectory } from "@/runtime-context";
import type { SubagentLaunchResult } from "@/types/subagent-protocol";
import { backgroundTasks } from "./process_manager.js";
import { LIMITS, truncateByChars } from "./truncation.js";

interface ForegroundOutcome {
  success: boolean;
  error?: string;
  agentId?: string;
  conversationId?: string;
  report?: string;
}

export type LaunchSubagent<A> = (
  args: A,
  options: { onComplete: (outcome: ForegroundOutcome) => void },
) => Promise<SubagentLaunchResult>;

/**
 * A subagent's Agent call blocks until the child finishes. A headless child
 * ends after its final report, so a background completion notification would
 * arrive after the turn that could use it. Parallel calls still run together.
 */
export async function runForegroundTask<A extends { signal?: AbortSignal }>(
  args: A,
  launchSubagent: LaunchSubagent<A>,
): Promise<string> {
  let finish: (outcome: ForegroundOutcome) => void = () => {};
  const done = new Promise<ForegroundOutcome>((resolve) => {
    finish = resolve;
  });
  const result = await launchSubagent(args, { onComplete: finish });
  if (!result.success) return `Error: ${result.error}`;
  const { signal } = args;
  const abort = () =>
    backgroundTasks.get(result.task_id)?.abortController?.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const outcome = await done;
    const agentId = outcome.agentId ?? result.agent_id;
    const conversationId = outcome.conversationId ?? result.conversation_id;
    const text = [
      `Agent ${outcome.success ? "completed" : "failed"} (task ${result.task_id})`,
      agentId ? `Agent ID: ${agentId}` : undefined,
      conversationId ? `Conversation ID: ${conversationId}` : undefined,
      `Output file: ${result.output_file}`,
      "",
      outcome.success
        ? outcome.report || ""
        : `Error: ${outcome.error || "Subagent execution failed"}`,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
    return truncateByChars(text, LIMITS.TASK_OUTPUT_CHARS, "Task", {
      workingDirectory: getCurrentWorkingDirectory(),
    }).content;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
