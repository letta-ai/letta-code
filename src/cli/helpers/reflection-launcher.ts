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
import { debugLog, debugWarn } from "@/utils/debug";

export const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";

/**
 * Maximum time to wait (in the background, non-blocking) for the spawned
 * reflection subagent to be assigned a concrete agent ID before we emit the
 * `reflection_start` telemetry event with whatever we have.
 *
 * Background: `spawnBackgroundSubagentTask` returns immediately with a local
 * task id, but the actual Letta agent is created asynchronously via an HTTP
 * POST that typically takes 1–10 seconds (longer under congestion or cold
 * start). Previously this wait was capped at 1s AND awaited inline, which
 * (a) blocked the reflection-launch path for up to 1s, and (b) almost always
 * timed out, causing `reflection_start.subagent_id` to be empty in 100% of
 * production rows.
 *
 * The fix: do the wait in the background and emit `reflection_start` when the
 * ID resolves. The launcher returns immediately so the trigger UX is
 * unaffected. 30s comfortably covers the agent-creation round trip in nearly
 * all cases. If we exceed the deadline we emit with `subagent_id` empty as a
 * last resort rather than dropping the event entirely.
 */
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

    // We need the resolved agent ID on `reflection_start` so dashboards can
    // identify the subagent for *in-flight* reflections (i.e. cases where
    // `reflection_end` never lands — crashes, early exits, long-running).
    // But we can't block the reflection-launch path on the agent-creation
    // HTTP round trip (1–10s, sometimes longer). So we defer the
    // `reflection_start` emission until the ID is known, in the background,
    // with a bounded 30s timeout. The launch path returns immediately.
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
      onComplete: async ({ success, error, agentId: reflectionAgentId }) => {
        telemetry.trackReflectionEnd(triggerSource, success, {
          subagentId: reflectionAgentId ?? undefined,
          conversationId,
          startMessageId: autoPayload.startMessageId,
          endMessageId: autoPayload.endMessageId,
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
    // Fire-and-forget: emit `reflection_start` as soon as the subagent has a
    // concrete agent ID, or after the bounded timeout. Either way, the event
    // ships with whatever ID is available at that point. The launcher itself
    // returns immediately so we never delay the reflection trigger UX.
    void waitForBackgroundSubagentAgentId(
      subagentId,
      REFLECTION_AGENT_ID_WAIT_MS,
    )
      .then((resolvedAgentId) => {
        emitReflectionStart(resolvedAgentId);
      })
      .catch((err) => {
        // Worst case — still emit the event with no subagent_id so we don't
        // lose visibility into the reflection trigger entirely.
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
