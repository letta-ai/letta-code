import { recompileAgentSystemPrompt } from "../../agent/modify";
import {
  estimateSystemTokens,
  setSystemPromptDoctorState,
} from "./systemPromptWarning";

export type MemorySubagentType = "init" | "reflection";

type RecompileAgentSystemPromptFn = (
  conversationId: string,
  agentId: string,
  dryRun?: boolean,
) => Promise<string>;

export interface MemorySubagentCompletionArgs {
  agentId: string;
  conversationId: string;
  subagentType: MemorySubagentType;
  success: boolean;
  error?: string;
}

export interface MemorySubagentCompletionDeps {
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  logRecompileFailure?: (message: string) => void;
  recompileAgentSystemPromptImpl?: RecompileAgentSystemPromptFn;
}

/**
 * Finalize a memory-writing subagent by recompiling the parent agent's
 * system prompt and returning the user-facing completion text.
 */
export async function handleMemorySubagentCompletion(
  args: MemorySubagentCompletionArgs,
  deps: MemorySubagentCompletionDeps,
): Promise<string> {
  const { agentId, conversationId, subagentType, success, error } = args;
  const recompileAgentSystemPromptFn =
    deps.recompileAgentSystemPromptImpl ?? recompileAgentSystemPrompt;
  let recompileError: string | null = null;

  if (success) {
    try {
      let inFlight = deps.recompileByConversation.get(conversationId);

      if (!inFlight) {
        inFlight = (async () => {
          do {
            deps.recompileQueuedByConversation.delete(conversationId);
            const compiledSystemPrompt = await recompileAgentSystemPromptFn(
              conversationId,
              agentId,
            );
            setSystemPromptDoctorState(
              agentId,
              estimateSystemTokens(compiledSystemPrompt),
            );
          } while (deps.recompileQueuedByConversation.has(conversationId));
        })().finally(() => {
          // Cleanup runs only after the shared promise settles, so every
          // concurrent caller awaits the same full recompile lifecycle.
          deps.recompileQueuedByConversation.delete(conversationId);
          deps.recompileByConversation.delete(conversationId);
        });
        deps.recompileByConversation.set(conversationId, inFlight);
      } else {
        deps.recompileQueuedByConversation.add(conversationId);
      }

      await inFlight;
    } catch (recompileFailure) {
      recompileError =
        recompileFailure instanceof Error
          ? recompileFailure.message
          : String(recompileFailure);
      deps.logRecompileFailure?.(
        `Failed to recompile system prompt after ${subagentType} subagent for ${agentId} in conversation ${conversationId}: ${recompileError}`,
      );
    }
  }

  if (!success) {
    const normalizedError = error || "Unknown error";
    if (subagentType === "reflection") {
      return `Tried to reflect, but got lost in the palace: ${normalizedError}`;
    }
    return `Memory initialization failed: ${normalizedError}`;
  }

  const baseMessage =
    subagentType === "reflection"
      ? "Reflected on /palace, the halls remember more now."
      : "Built a memory palace of you. Visit it with /palace.";

  if (!recompileError) {
    return baseMessage;
  }

  return `${baseMessage} System prompt recompilation failed: ${recompileError}`;
}
