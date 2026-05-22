import { getSubagents } from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import type { ReflectionTrigger } from "@/cli/helpers/memory-reminder";
import { handleMemorySubagentCompletion } from "@/cli/helpers/memory-subagent-completion";
import { isReflectionSubagentActive } from "@/cli/helpers/reflection-gate";
import {
  buildAutoReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
  finalizeAutoReflectionPayload,
} from "@/cli/helpers/reflection-transcript";
import { telemetry } from "@/telemetry";
import { debugLog, debugWarn } from "@/utils/debug";

export const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";

export type ReflectionLaunchTriggerSource =
  | "manual"
  | Exclude<ReflectionTrigger, "off">;

export type ReflectionLaunchSkippedReason =
  | "memfs_disabled"
  | "already_active"
  | "no_payload"
  | "error";

export type ReflectionLaunchResult =
  | {
      launched: true;
      payloadPath: string;
      subagentId: string;
      reflectionAgentId?: string;
      startMessageId?: string;
      endMessageId?: string;
    }
  | {
      launched: false;
      reason: ReflectionLaunchSkippedReason;
      error?: unknown;
    };

export interface ReflectionLaunchOptions {
  agentId: string;
  conversationId: string;
  memoryDir: string;
  memfsEnabled: boolean;
  triggerSource: ReflectionLaunchTriggerSource;
  description: string;
  systemPrompt?: string;
  completionConversationId?: string | (() => string);
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  onCompletionMessage?: (
    message: string,
    result: {
      success: boolean;
      error?: string;
      reflectionAgentId?: string;
    },
  ) => void | Promise<void>;
}

async function resolveSystemPrompt(
  agentId: string,
  systemPrompt: string | undefined,
): Promise<string | undefined> {
  if (systemPrompt) {
    return systemPrompt;
  }

  try {
    const agent = await getBackend().retrieveAgent(agentId);
    return agent.system ?? undefined;
  } catch {
    debugLog(
      "memory",
      "Failed to fetch agent system prompt for reflection payload",
    );
    return undefined;
  }
}

function resolveCompletionConversationId(
  completionConversationId: ReflectionLaunchOptions["completionConversationId"],
  fallback: string,
): string {
  if (typeof completionConversationId === "function") {
    return completionConversationId();
  }
  return completionConversationId ?? fallback;
}

export async function launchReflectionSubagent(
  options: ReflectionLaunchOptions,
): Promise<ReflectionLaunchResult> {
  const {
    agentId,
    conversationId,
    memoryDir,
    memfsEnabled,
    triggerSource,
    description,
    recompileByConversation,
    recompileQueuedByConversation,
    onCompletionMessage,
  } = options;

  if (!memfsEnabled) {
    return { launched: false, reason: "memfs_disabled" };
  }

  if (isReflectionSubagentActive(getSubagents(), agentId, conversationId)) {
    debugLog(
      "memory",
      `Skipping reflection launch (${triggerSource}) because one is already active`,
    );
    return { launched: false, reason: "already_active" };
  }

  try {
    const systemPrompt = await resolveSystemPrompt(
      agentId,
      options.systemPrompt,
    );
    const autoPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
      systemPrompt,
    );
    if (!autoPayload) {
      debugLog(
        "memory",
        `Skipping reflection launch (${triggerSource}) because transcript has no new content`,
      );
      return { launched: false, reason: "no_payload" };
    }

    const parentMemory = await buildParentMemorySnapshot(memoryDir);
    const reflectionPrompt = buildReflectionSubagentPrompt({
      memoryDir,
      parentMemory,
    });

    const { spawnBackgroundSubagentTask, waitForBackgroundSubagentAgentId } =
      await import("@/tools/impl/task");
    const { subagentId } = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: reflectionPrompt,
      description,
      silentCompletion: true,
      transcriptPath: autoPayload.payloadPath,
      parentScope: { agentId, conversationId },
      onComplete: async ({ success, error, agentId: reflectionAgentId }) => {
        telemetry.trackReflectionEnd(triggerSource, success, {
          subagentId: reflectionAgentId ?? undefined,
          conversationId,
          error,
        });
        await finalizeAutoReflectionPayload(
          agentId,
          conversationId,
          autoPayload.payloadPath,
          autoPayload.endSnapshotLine,
          success,
        );

        const completionMessage = await handleMemorySubagentCompletion(
          {
            agentId,
            conversationId: resolveCompletionConversationId(
              options.completionConversationId,
              conversationId,
            ),
            subagentType: "reflection",
            success,
            error,
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
          reflectionAgentId: reflectionAgentId ?? undefined,
        });
      },
    });
    const reflectionAgentId = await waitForBackgroundSubagentAgentId(
      subagentId,
      1000,
    );
    telemetry.trackReflectionStart(triggerSource, {
      subagentId: reflectionAgentId ?? undefined,
      conversationId,
      startMessageId: autoPayload.startMessageId,
      endMessageId: autoPayload.endMessageId,
    });

    debugLog("memory", `Launched reflection subagent (${triggerSource})`);
    return {
      launched: true,
      payloadPath: autoPayload.payloadPath,
      subagentId,
      reflectionAgentId: reflectionAgentId ?? undefined,
      startMessageId: autoPayload.startMessageId,
      endMessageId: autoPayload.endMessageId,
    };
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to launch reflection subagent (${triggerSource}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "error", error };
  }
}
