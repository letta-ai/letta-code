/**
 * Post-tool hook feedback: collection and attachment to model-facing tool
 * results.
 *
 * Hooks run user-configured shell commands whose children inherit the runtime
 * environment (including LETTA_API_KEY), so their feedback can echo runtime
 * credentials. All feedback attached here is scrubbed for ambient runtime auth
 * values before it reaches the model — the secret scrub of the tool's own
 * output runs earlier and cannot cover text appended afterwards.
 */

import { runPostToolUseFailureHooks, runPostToolUseHooks } from "@/hooks";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";
import { debugLog } from "@/utils/debug";

export type ToolHookContext = {
  args: Record<string, unknown>;
  debugLabel: string;
  scopedAgentId?: string;
  toolCallId?: string;
  toolName: string;
  workingDirectory: string;
};

export async function collectPostToolHookFeedback(
  context: ToolHookContext,
  result: {
    errorType?: string;
    failureOutput?: string;
    output: string;
    status: "success" | "error";
  },
): Promise<string[]> {
  let postToolUseFeedback: string[] = [];
  try {
    const postHookResult = await runPostToolUseHooks(
      context.toolName,
      context.args,
      { status: result.status, output: result.output },
      context.toolCallId,
      context.workingDirectory,
      context.scopedAgentId,
      undefined,
      undefined,
    );
    postToolUseFeedback = postHookResult.feedback;
  } catch (error) {
    debugLog("hooks", `PostToolUse hook error (${context.debugLabel})`, error);
  }

  let postToolUseFailureFeedback: string[] = [];
  if (result.status === "error") {
    try {
      const failureHookResult = await runPostToolUseFailureHooks(
        context.toolName,
        context.args,
        result.failureOutput ?? result.output,
        result.errorType ?? "tool_error",
        context.toolCallId,
        context.workingDirectory,
        context.scopedAgentId,
        undefined,
        undefined,
      );
      postToolUseFailureFeedback = failureHookResult.feedback;
    } catch (error) {
      debugLog(
        "hooks",
        `PostToolUseFailure hook error (${context.debugLabel})`,
        error,
      );
    }
  }

  return [...postToolUseFeedback, ...postToolUseFailureFeedback];
}

export function appendHookFeedbackToText(
  text: string,
  feedback: string[],
): string {
  if (feedback.length === 0) return text;
  const scrubbed = scrubAmbientSecrets(feedback.join("\n"));
  return `${text}\n\n[Hook feedback]:\n${scrubbed}`;
}

export function appendHookFeedbackToToolReturn<
  T extends string | Array<{ type?: string; text?: unknown }>,
>(toolReturn: T, feedback: string[]): T {
  if (feedback.length === 0) return toolReturn;
  const feedbackMessage = `\n\n[Hook feedback]:\n${scrubAmbientSecrets(feedback.join("\n"))}`;
  if (typeof toolReturn === "string") {
    return (toolReturn + feedbackMessage) as T;
  }
  return [...toolReturn, { type: "text" as const, text: feedbackMessage }] as T;
}
