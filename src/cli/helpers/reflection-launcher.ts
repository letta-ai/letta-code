import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getSubagents } from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import type { ReflectionTrigger } from "@/cli/helpers/memory-reminder";
import { handleMemorySubagentCompletion } from "@/cli/helpers/memory-subagent-completion";
import {
  buildAutoReflectionPayload,
  buildMultiReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
  finalizeAutoReflectionPayload,
  finalizeMultiReflectionPayload,
  recordMetaReflectionResult,
  recordSuccessfulReflectionForMetaTrigger,
} from "@/cli/helpers/reflection-transcript";
import { telemetry } from "@/telemetry";
import { maybeSendReflectionThresholdFeedback } from "@/telemetry/reflection-threshold-feedback";
import { debugLog, debugWarn } from "@/utils/debug";

export const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";
export const AUTO_META_REFLECTION_INTERVAL = 10;
export const AUTO_META_REFLECTION_RECENT_LIMIT = 10;

const AUTO_META_REFLECTION_INSTRUCTION =
  "This is an automatic meta-reflection triggered after 10 successful reflection passes; the included conversations were already reflected on individually, so focus on higher-level patterns that only emerge across them.";

/** Max background wait for the reflection subagent's agent ID before emitting `reflection_start` (previously 1s inline, timed out ~100% of the time). */
export const REFLECTION_AGENT_ID_WAIT_MS = 30_000;

const reservedReflectionAgentIds = new Set<string>();

export type ReflectionLaunchTriggerSource =
  | "manual"
  | "meta-reflection"
  | Exclude<ReflectionTrigger, "off">;

export type ReflectionLaunchSkippedReason =
  | "memfs_disabled"
  | "already_active"
  | "no_payload"
  | "error";

function drainReflectionTelemetry(): void {
  telemetry.drain().catch((error) => {
    debugWarn(
      "telemetry",
      `Failed to flush reflection telemetry: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

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
  instruction?: string;
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

function isReflectionSubagentActiveForAgent(agentId: string): boolean {
  return getSubagents().some((agent) => {
    if (agent.type.toLowerCase() !== "reflection") {
      return false;
    }
    if (agent.status !== "pending" && agent.status !== "running") {
      return false;
    }
    return agent.parentAgentId === agentId;
  });
}

export function tryReserveReflectionLaunch(agentId: string): boolean {
  if (reservedReflectionAgentIds.has(agentId)) {
    return false;
  }
  if (isReflectionSubagentActiveForAgent(agentId)) {
    return false;
  }
  reservedReflectionAgentIds.add(agentId);
  return true;
}

export function releaseReflectionLaunch(agentId: string): void {
  reservedReflectionAgentIds.delete(agentId);
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

async function launchMetaReflectionSubagent(
  options: ReflectionLaunchOptions & { systemPrompt?: string },
): Promise<ReflectionLaunchResult> {
  const {
    agentId,
    conversationId,
    memfsEnabled,
    recompileByConversation,
    recompileQueuedByConversation,
    onCompletionMessage,
  } = options;
  const triggerSource: ReflectionLaunchTriggerSource = "meta-reflection";

  if (!memfsEnabled) {
    return { launched: false, reason: "memfs_disabled" };
  }

  if (!tryReserveReflectionLaunch(agentId)) {
    debugLog(
      "memory",
      "Skipping meta-reflection launch because a reflection is already active",
    );
    return { launched: false, reason: "already_active" };
  }

  let releaseOnComplete = false;
  try {
    const reflectionPayload = await buildMultiReflectionPayload({
      agentId,
      selectionPolicy: {
        mode: "recent",
        limit: AUTO_META_REFLECTION_RECENT_LIMIT,
      },
      instruction: AUTO_META_REFLECTION_INSTRUCTION,
      systemPrompt: options.systemPrompt,
      rangeMode: "replay",
    });
    if (!reflectionPayload) {
      releaseReflectionLaunch(agentId);
      return { launched: false, reason: "no_payload" };
    }

    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    const parentMemory = await buildParentMemorySnapshot(memoryDir);
    const reflectionPrompt = buildReflectionSubagentPrompt({
      instruction: AUTO_META_REFLECTION_INSTRUCTION,
      memoryDir,
      parentMemory,
      mode: "multi",
    });

    const { spawnBackgroundSubagentTask, waitForBackgroundSubagentAgentId } =
      await import("@/tools/impl/task");

    const emitReflectionStart = (resolvedAgentId: string | null) => {
      telemetry.trackReflectionStart(triggerSource, {
        subagentId: resolvedAgentId ?? undefined,
        conversationId,
        startMessageId: reflectionPayload.startMessageId,
        endMessageId: reflectionPayload.endMessageId,
      });
      drainReflectionTelemetry();
    };

    const { subagentId } = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: reflectionPrompt,
      description: "Meta-reflect on recent reflections",
      silentCompletion: true,
      transcriptPath: reflectionPayload.payloadPath,
      parentScope: { agentId, conversationId },
      onComplete: async ({
        success,
        error,
        agentId: reflectionAgentId,
        stepCount,
        durationMs,
      }) => {
        try {
          telemetry.trackReflectionEnd(triggerSource, success, {
            subagentId: reflectionAgentId ?? undefined,
            conversationId,
            error,
            stepCount,
            durationMs,
          });
          drainReflectionTelemetry();
          await finalizeMultiReflectionPayload(
            agentId,
            reflectionPayload.manifest,
            success,
          );
          await recordMetaReflectionResult(agentId, success);

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
              subagentAgentId: reflectionAgentId ?? undefined,
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
        } finally {
          releaseReflectionLaunch(agentId);
        }
      },
    });
    releaseOnComplete = true;

    void waitForBackgroundSubagentAgentId(
      subagentId,
      REFLECTION_AGENT_ID_WAIT_MS,
    )
      .then((resolvedAgentId) => emitReflectionStart(resolvedAgentId))
      .catch((err) => {
        debugWarn(
          "memory",
          `Failed waiting for meta-reflection agent ID: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        emitReflectionStart(null);
      });

    debugLog("memory", "Launched meta-reflection subagent");
    await onCompletionMessage?.(
      `Automatic meta-reflection triggered after ${AUTO_META_REFLECTION_INTERVAL} successful reflection passes. Payload: ${reflectionPayload.payloadPath}`,
      { success: true },
    );
    return {
      launched: true,
      payloadPath: reflectionPayload.payloadPath,
      subagentId,
      startMessageId: reflectionPayload.startMessageId,
      endMessageId: reflectionPayload.endMessageId,
    };
  } catch (error) {
    if (!releaseOnComplete) {
      releaseReflectionLaunch(agentId);
    }
    debugWarn(
      "memory",
      `Failed to launch meta-reflection subagent: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "error", error };
  }
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

  if (!tryReserveReflectionLaunch(agentId)) {
    debugLog(
      "memory",
      `Skipping reflection launch (${triggerSource}) because one is already active`,
    );
    return { launched: false, reason: "already_active" };
  }

  let releaseOnComplete = false;
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
      releaseReflectionLaunch(agentId);
      return { launched: false, reason: "no_payload" };
    }

    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    const parentMemory = await buildParentMemorySnapshot(memoryDir);
    const reflectionPrompt = buildReflectionSubagentPrompt({
      instruction: options.instruction,
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
      drainReflectionTelemetry();
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
        let shouldLaunchMetaReflection = false;
        try {
          telemetry.trackReflectionEnd(triggerSource, success, {
            subagentId: reflectionAgentId ?? undefined,
            conversationId,
            error,
            stepCount,
            durationMs,
          });
          drainReflectionTelemetry();
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
          if (success && triggerSource !== "meta-reflection") {
            ({ shouldLaunchMetaReflection } =
              await recordSuccessfulReflectionForMetaTrigger(agentId, {
                interval: AUTO_META_REFLECTION_INTERVAL,
              }));
          }

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
              subagentAgentId: reflectionAgentId ?? undefined,
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
        } finally {
          releaseReflectionLaunch(agentId);
          if (shouldLaunchMetaReflection) {
            void launchMetaReflectionSubagent({
              ...options,
              systemPrompt,
              triggerSource: "meta-reflection",
              description: "Meta-reflect on recent reflections",
            });
          }
        }
      },
    });
    releaseOnComplete = true;
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
    if (!releaseOnComplete) {
      releaseReflectionLaunch(agentId);
    }
    debugWarn(
      "memory",
      `Failed to launch reflection subagent (${triggerSource}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "error", error };
  }
}
