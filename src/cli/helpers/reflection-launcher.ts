import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
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
import { maybeSendReflectionThresholdFeedback } from "@/telemetry/reflection-threshold-feedback";
import { debugLog, debugWarn } from "@/utils/debug";

export const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";

/** Max background wait for the reflection subagent's agent ID before emitting `reflection_start` (previously 1s inline, timed out ~100% of the time). */
export const REFLECTION_AGENT_ID_WAIT_MS = 30_000;

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
  feedbackContext?: {
    parentAgentName?: string | null;
    parentAgentDescription?: string | null;
    model?: string | null;
    surface?: string;
  };
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

    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    const parentMemory = await buildParentMemorySnapshot(memoryDir);
    const reflectionPrompt = buildReflectionSubagentPrompt({
      memoryDir,
      parentMemory,
    });

    const { spawnBackgroundSubagentTask, waitForBackgroundSubagentAgentId } =
      await import("@/tools/impl/task");

    // Defer `reflection_start` until the agent ID resolves (background, bounded by REFLECTION_AGENT_ID_WAIT_MS).
    const emitReflectionStart = (resolvedAgentId: string | null) => {
      telemetry.trackReflectionStart(triggerSource, {
        subagentId: resolvedAgentId ?? undefined,
        conversationId,
        startMessageId: autoPayload.startMessageId,
        endMessageId: autoPayload.endMessageId,
      });
    };

    const { subagentId } = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: reflectionPrompt,
      description,
      silentCompletion: true,
      transcriptPath: autoPayload.payloadPath,
      parentScope: { agentId, conversationId },
      onComplete: async ({
        success,
        error,
        agentId: reflectionAgentId,
        stepCount,
        durationMs,
      }) => {
        telemetry.trackReflectionEnd(triggerSource, success, {
          subagentId: reflectionAgentId ?? undefined,
          conversationId,
          error,
          stepCount,
          durationMs,
        });
        maybeSendReflectionThresholdFeedback({
          parentAgentId: agentId,
          parentAgentName: options.feedbackContext?.parentAgentName,
          parentAgentDescription:
            options.feedbackContext?.parentAgentDescription,
          reflectionSubagentId: reflectionAgentId ?? undefined,
          conversationId,
          triggerSource,
          success,
          error,
          stepCount,
          durationMs,
          surface: options.feedbackContext?.surface,
          model: options.feedbackContext?.model,
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
    // Fire-and-forget: emit `reflection_start` when the agent ID resolves or after timeout.
    void waitForBackgroundSubagentAgentId(
      subagentId,
      REFLECTION_AGENT_ID_WAIT_MS,
    )
      .then((resolvedAgentId) => {
        emitReflectionStart(resolvedAgentId);
      })
      .catch((err) => {
        // Worst case — still emit with no subagent_id so we don't lose the event.
        debugWarn(
          "memory",
          `Failed waiting for reflection agent ID: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        emitReflectionStart(null);
      });

    debugLog("memory", `Launched reflection subagent (${triggerSource})`);
    return {
      launched: true,
      payloadPath: autoPayload.payloadPath,
      subagentId,
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
