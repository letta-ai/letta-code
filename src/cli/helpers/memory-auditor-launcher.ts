import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import memoryPrinciplesMd from "@/agent/prompts/memory_principles.md";
import { handleMemorySubagentCompletion } from "@/cli/helpers/memory-subagent-completion";
import {
  releaseReflectionLaunch,
  tryReserveReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import { buildParentMemorySnapshot } from "@/cli/helpers/reflection-transcript";
import { debugLog, debugWarn } from "@/utils/debug";

export const MEMORY_AUDITOR_DESCRIPTION = "Audit and reorganize memory";

/**
 * Model the memory auditor runs on. Passed verbatim as the subagent's
 * `userModel` so it reaches the child as `--model <id>` — using the model
 * *id* (not the bare handle) so its updateArgs (notably reasoning_effort)
 * are applied on agent creation. `resolveModel()` would collapse the id to
 * its handle and drop the reasoning level.
 */
export const MEMORY_AUDITOR_MODEL = "gpt-5.5-plus-pro-high";

export interface MemoryAuditorPromptInput {
  instruction?: string;
  memoryDir: string;
  parentMemory?: string;
}

/**
 * Build the first message for the memory auditor subagent. Unlike reflection,
 * there is no conversation transcript — the auditor's subject is the memory
 * filesystem itself, so we inline the maintenance principles and the parent
 * memory snapshot.
 */
export function buildMemoryAuditorPrompt(
  input: MemoryAuditorPromptInput,
): string {
  const lines: string[] = [];

  lines.push(
    "You are auditing and reorganizing the primary agent's memory filesystem for hygiene and structure. There is no conversation transcript to review — the memory itself is your subject.",
    "",
    `The primary agent's memory filesystem is located at: ${input.memoryDir}`,
    "In-context memory (the parent agent's system prompt) is stored in the `system/` folder and is rendered in <memory> tags below. Editing a file in `system/` edits the parent agent's system prompt.",
    "Skills and external memory files may also be read, moved, and modified.",
    "",
    "Follow these Memory Maintenance Principles:",
    "",
    "<memory_principles>",
    memoryPrinciplesMd.trim(),
    "</memory_principles>",
    "",
  );

  if (input.instruction?.trim()) {
    lines.push(
      "Additional user-provided audit instruction:",
      input.instruction.trim(),
      "",
      "Use this instruction to focus the audit, but still apply the principles above across the whole memory filesystem.",
      "",
    );
  }

  if (input.parentMemory) {
    lines.push(input.parentMemory);
  }

  return lines.join("\n");
}

export type MemoryAuditorLaunchSkippedReason =
  | "memfs_disabled"
  | "already_active"
  | "error";

export type MemoryAuditorLaunchResult =
  | {
      launched: true;
      subagentId: string;
    }
  | {
      launched: false;
      reason: MemoryAuditorLaunchSkippedReason;
      error?: unknown;
    };

export interface MemoryAuditorLaunchOptions {
  agentId: string;
  conversationId: string;
  memfsEnabled: boolean;
  description?: string;
  instruction?: string;
  completionConversationId?: string | (() => string);
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  onCompletionMessage?: (
    message: string,
    result: {
      success: boolean;
      error?: string;
      auditorAgentId?: string;
    },
  ) => void | Promise<void>;
}

function resolveCompletionConversationId(
  completionConversationId: MemoryAuditorLaunchOptions["completionConversationId"],
  fallback: string,
): string {
  if (typeof completionConversationId === "function") {
    return completionConversationId();
  }
  return completionConversationId ?? fallback;
}

/**
 * Launch the memory auditor subagent in the background. Reuses the reflection
 * launch reservation so an audit and a reflection never run concurrently
 * against the same MemFS git repo.
 */
export async function launchMemoryAuditorSubagent(
  options: MemoryAuditorLaunchOptions,
): Promise<MemoryAuditorLaunchResult> {
  const {
    agentId,
    conversationId,
    memfsEnabled,
    recompileByConversation,
    recompileQueuedByConversation,
    onCompletionMessage,
  } = options;

  if (!memfsEnabled) {
    return { launched: false, reason: "memfs_disabled" };
  }

  if (!tryReserveReflectionLaunch(agentId)) {
    debugLog(
      "memory",
      "Skipping memory audit launch because a memory subagent is already active",
    );
    return { launched: false, reason: "already_active" };
  }

  let releaseOnComplete = false;
  try {
    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    const parentMemory = await buildParentMemorySnapshot(memoryDir);
    const prompt = buildMemoryAuditorPrompt({
      instruction: options.instruction,
      memoryDir,
      parentMemory,
    });

    const { spawnBackgroundSubagentTask } = await import("@/tools/impl/task");
    const description = options.description ?? MEMORY_AUDITOR_DESCRIPTION;

    const { subagentId } = spawnBackgroundSubagentTask({
      subagentType: "memory-auditor",
      prompt,
      description,
      model: MEMORY_AUDITOR_MODEL,
      silentCompletion: true,
      parentScope: { agentId, conversationId },
      onComplete: async ({ success, error, agentId: auditorAgentId }) => {
        try {
          const completionMessage = await handleMemorySubagentCompletion(
            {
              agentId,
              conversationId: resolveCompletionConversationId(
                options.completionConversationId,
                conversationId,
              ),
              subagentType: "memory-auditor",
              success,
              error,
              subagentAgentId: auditorAgentId ?? undefined,
            },
            {
              recompileByConversation,
              recompileQueuedByConversation,
              logRecompileFailure: (message) => debugWarn("memory", message),
            },
          );
          await onCompletionMessage?.(completionMessage, {
            success,
            error,
            auditorAgentId: auditorAgentId ?? undefined,
          });
        } finally {
          releaseReflectionLaunch(agentId);
        }
      },
    });
    releaseOnComplete = true;

    debugLog("memory", "Launched memory auditor subagent");
    return { launched: true, subagentId };
  } catch (error) {
    if (!releaseOnComplete) {
      releaseReflectionLaunch(agentId);
    }
    debugWarn(
      "memory",
      `Failed to launch memory auditor subagent: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "error", error };
  }
}
