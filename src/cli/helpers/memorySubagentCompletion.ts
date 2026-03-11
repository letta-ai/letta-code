import {
  type RecompileAgentSystemPromptOptions,
  recompileAgentSystemPrompt,
} from "../../agent/modify";

export type MemorySubagentType = "init" | "reflection";
export type MemoryInitDepth = "shallow" | "deep";

export interface MemoryInitProgressUpdate {
  shallowCompleted: boolean;
  deepFired: boolean;
}

type RecompileAgentSystemPromptFn = (
  conversationId: string,
  options?: RecompileAgentSystemPromptOptions,
) => Promise<string>;

export type MemorySubagentCompletionArgs =
  | {
      agentId: string;
      conversationId: string;
      subagentType: "init";
      initDepth: MemoryInitDepth;
      success: boolean;
      error?: string;
    }
  | {
      agentId: string;
      conversationId: string;
      subagentType: "reflection";
      initDepth?: never;
      success: boolean;
      error?: string;
    };

export interface MemorySubagentCompletionDeps {
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  updateInitProgress: (
    agentId: string,
    update: Partial<MemoryInitProgressUpdate>,
  ) => void;
  logRecompileFailure?: (message: string) => void;
  recompileAgentSystemPromptImpl?: RecompileAgentSystemPromptFn;
}

/**
 * Finalize a memory-writing subagent by updating init progress, recompiling the
 * parent agent's system prompt, and returning the user-facing completion text.
 */
export async function handleMemorySubagentCompletion(
  args: MemorySubagentCompletionArgs,
  deps: MemorySubagentCompletionDeps,
): Promise<string> {
  const { agentId, conversationId, subagentType, initDepth, success, error } =
    args;
  const recompileAgentSystemPromptFn =
    deps.recompileAgentSystemPromptImpl ?? recompileAgentSystemPrompt;
  let recompileError: string | null = null;

  if (success) {
    if (subagentType === "init") {
      deps.updateInitProgress(
        agentId,
        initDepth === "shallow"
          ? { shallowCompleted: true }
          : { deepFired: true },
      );
    }

    try {
      let inFlight = deps.recompileByConversation.get(conversationId);

      if (!inFlight) {
        inFlight = (async () => {
          do {
            deps.recompileQueuedByConversation.delete(conversationId);
            await recompileAgentSystemPromptFn(conversationId, {});
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
    return initDepth === "deep"
      ? `Deep memory initialization failed: ${normalizedError}`
      : `Memory initialization failed: ${normalizedError}`;
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
