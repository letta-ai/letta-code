import { recompileAgentSystemPrompt } from "@/agent/modify";
import { isDebugEnabled } from "@/utils/debug";
import { buildAgentTerminalLink, isLocalAgentId } from "./app-urls";
import {
  estimateSystemTokens,
  setSystemPromptDoctorState,
} from "./system-prompt-warning";

export type MemorySubagentType = "init" | "reflection";

export type MemorySubagentSuccessMessageOverride =
  | string
  | ((args: { action: string; defaultMessage: string }) => string);

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
  subagentAgentId?: string;
  skipRecompile?: boolean;
  successMessageOverride?: MemorySubagentSuccessMessageOverride;
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
  const subagentLink = args.subagentAgentId
    ? buildAgentTerminalLink(args.subagentAgentId, undefined, "Dreamed")
    : null;
  const canLinkSubagent = args.subagentAgentId
    ? !isLocalAgentId(args.subagentAgentId)
    : false;
  const recompileAgentSystemPromptFn =
    deps.recompileAgentSystemPromptImpl ?? recompileAgentSystemPrompt;
  let recompileError: string | null = null;

  if (success && !args.skipRecompile) {
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
    if (subagentType === "reflection") {
      if (args.successMessageOverride) {
        const action =
          subagentLink && canLinkSubagent ? subagentLink : "Dreamed";
        const defaultMessage = `${action} and made some memories.`;
        return typeof args.successMessageOverride === "function"
          ? args.successMessageOverride({ action, defaultMessage })
          : args.successMessageOverride;
      }
      const detail = isDebugEnabled() ? `: ${error || "Unknown error"}` : "";
      return `Tried to reflect, but got lost in the palace${detail}`;
    }
    const normalizedError = error || "Unknown error";
    return `Memory initialization failed: ${normalizedError}`;
  }

  const action =
    subagentType === "reflection" && subagentLink && canLinkSubagent
      ? subagentLink
      : subagentType === "reflection"
        ? "Dreamed"
        : "Built";
  const defaultMessage =
    subagentType === "reflection"
      ? `${action} and made some memories.`
      : "Built a memory palace of you. Visit it with /palace.";
  const baseMessage =
    typeof args.successMessageOverride === "function"
      ? args.successMessageOverride({ action, defaultMessage })
      : (args.successMessageOverride ?? defaultMessage);

  if (!recompileError) {
    return baseMessage;
  }

  return `${baseMessage} System prompt recompilation failed: ${recompileError}`;
}
