import { recompileAgentSystemPrompt } from "../../agent/modify";

export type MemorySubagentType = "init" | "reflection";
export type MemoryInitDepth = "shallow" | "deep";

export interface MemoryInitProgressUpdate {
  shallowCompleted: boolean;
  deepFired: boolean;
}

export interface MemorySubagentCompletionArgs {
  agentId: string;
  subagentType: MemorySubagentType;
  initDepth?: MemoryInitDepth;
  success: boolean;
  error?: string;
}

export interface MemorySubagentCompletionDeps {
  recompileByAgent: Map<string, Promise<void>>;
  updateInitProgress: (
    agentId: string,
    update: Partial<MemoryInitProgressUpdate>,
  ) => void;
  logRecompileFailure?: (message: string) => void;
}

/**
 * Finalize a memory-writing subagent by updating init progress, recompiling the
 * parent agent's system prompt, and returning the user-facing completion text.
 */
export async function handleMemorySubagentCompletion(
  args: MemorySubagentCompletionArgs,
  deps: MemorySubagentCompletionDeps,
): Promise<string> {
  const { agentId, subagentType, initDepth, success, error } = args;
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
      let inFlight = deps.recompileByAgent.get(agentId);
      let createdRecompile = false;

      if (!inFlight) {
        createdRecompile = true;
        inFlight = (async () => {
          await recompileAgentSystemPrompt(agentId, {
            updateTimestamp: true,
          });
        })();
        deps.recompileByAgent.set(agentId, inFlight);
      }

      try {
        await inFlight;
      } finally {
        if (createdRecompile) {
          deps.recompileByAgent.delete(agentId);
        }
      }
    } catch (recompileFailure) {
      recompileError =
        recompileFailure instanceof Error
          ? recompileFailure.message
          : String(recompileFailure);
      deps.logRecompileFailure?.(
        `Failed to recompile system prompt after ${subagentType} subagent for ${agentId}: ${recompileError}`,
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
