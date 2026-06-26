import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  type ReflectionMemoryWorktree,
  type ReflectionMemoryWorktreeFinalizeResult,
  reflectionIntegrationConsumesTranscript,
  reflectionIntegrationNeedsReminder,
  reflectionIntegrationShouldRecompile,
} from "@/agent/memory-worktree";
import { getSubagents } from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import type { ReflectionTrigger } from "@/cli/helpers/memory-reminder";
import { handleMemorySubagentCompletion } from "@/cli/helpers/memory-subagent-completion";
import {
  buildAutoReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
  finalizeAutoReflectionPayload,
} from "@/cli/helpers/reflection-transcript";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { telemetry } from "@/telemetry";
import { maybeSendReflectionThresholdFeedback } from "@/telemetry/reflection-threshold-feedback";
import { debugLog, debugWarn } from "@/utils/debug";
import { addToMessageQueue } from "@/utils/message-queue-bridge";

export const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";

/** Max background wait for the reflection subagent's agent ID before emitting `reflection_start` (previously 1s inline, timed out ~100% of the time). */
export const REFLECTION_AGENT_ID_WAIT_MS = 30_000;

const reservedReflectionAgentIds = new Set<string>();
const pendingReflectionLaunches = new Map<string, ReflectionLaunchOptions>();

export type ReflectionLaunchTriggerSource =
  | "manual"
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
  schedulePendingReflectionLaunch(agentId);
}

function queuePendingReflectionLaunch(options: ReflectionLaunchOptions): void {
  pendingReflectionLaunches.set(options.agentId, options);
  debugLog(
    "memory",
    `Queued reflection launch (${options.triggerSource}) until active reflection finishes`,
  );
}

function schedulePendingReflectionLaunch(agentId: string): void {
  const pendingOptions = pendingReflectionLaunches.get(agentId);
  if (!pendingOptions) return;
  pendingReflectionLaunches.delete(agentId);

  queueMicrotask(() => {
    void launchReflectionSubagent(pendingOptions).catch((error) => {
      debugWarn(
        "memory",
        `Failed to launch queued reflection (${pendingOptions.triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
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

function getReflectionCompletionMessage(
  integration: ReflectionMemoryWorktreeFinalizeResult,
): string | undefined {
  switch (integration.status) {
    case "merged":
      return undefined;
    case "no_changes":
      return "Dreamed; no durable memory changes were needed.";
    case "pending_conflict":
      return "Dreamed and produced memory updates, but a MemFS merge conflict needs manual resolution.";
    case "pending_manual_merge":
      return "Dreamed and produced memory updates, but the MemFS merge needs manual completion.";
    case "dirty_uncommitted":
      return "Tried to reflect, but left uncommitted memory changes in its worktree.";
    case "preserved":
      return "Tried to reflect, but the memory worktree was preserved for manual inspection.";
  }
}

export function formatReflectionIntegrationReminder(
  integration: ReflectionMemoryWorktreeFinalizeResult,
): string {
  const conflictWorktree = integration.integrationWorktreeDir;
  const integrationBranch = integration.integrationBranch;
  const resolveCommands = conflictWorktree
    ? `cd ${JSON.stringify(conflictWorktree)}
git status
# resolve conflicted memory files, then:
git add -A
git commit --no-edit

cd ${JSON.stringify(integration.parentMemoryDir)}
git merge --ff-only ${JSON.stringify(integrationBranch ?? "<integration-branch>")}
git worktree remove ${JSON.stringify(conflictWorktree)}
git branch -d ${JSON.stringify(integration.reflectionBranch)} ${JSON.stringify(integrationBranch ?? "<integration-branch>")}`
    : `cd ${JSON.stringify(integration.parentMemoryDir)}
git status
# commit or discard any unrelated parent MemFS changes, then:
git merge ${JSON.stringify(integration.reflectionBranch)} --no-edit
git worktree remove ${JSON.stringify(integration.reflectionWorktreeDir)}
git branch -d ${JSON.stringify(integration.reflectionBranch)}`;

  return `${SYSTEM_REMINDER_OPEN}
MEMORY REFLECTION MERGE NEEDED: A background reflection completed and produced committed memory updates, but the harness could not merge them into your main MemFS automatically.

Parent memory dir: ${integration.parentMemoryDir}
Reflection branch: ${integration.reflectionBranch}
${integration.integrationBranch ? `Integration branch: ${integration.integrationBranch}\n` : ""}${integration.integrationWorktreeDir ? `Conflict worktree: ${integration.integrationWorktreeDir}\n` : ""}Status: ${integration.summary}

Resolve when appropriate:
\`\`\`bash
${resolveCommands}
\`\`\`

This reminder is one-time. The transcript was already reflected, so do not launch another reflection for the same content just to resolve this merge.
${SYSTEM_REMINDER_CLOSE}`;
}

function queueReflectionIntegrationReminder(params: {
  agentId: string;
  conversationId: string;
  integration: ReflectionMemoryWorktreeFinalizeResult;
}): void {
  addToMessageQueue({
    kind: "task_notification",
    text: formatReflectionIntegrationReminder(params.integration),
    agentId: params.agentId,
    conversationId: params.conversationId,
  });
}

export async function prepareReflectionMemoryWorktreeLaunch(params: {
  agentId: string;
  instruction?: string;
}): Promise<{
  worktree: ReflectionMemoryWorktree;
  reflectionPrompt: string;
}> {
  const memoryDir = getScopedMemoryFilesystemRoot(params.agentId);
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: memoryDir,
  });
  try {
    const parentMemory = await buildParentMemorySnapshot(worktree.worktreeDir);
    const reflectionPrompt = buildReflectionSubagentPrompt({
      instruction: params.instruction,
      memoryDir: worktree.worktreeDir,
      parentMemory,
    });
    return { worktree, reflectionPrompt };
  } catch (error) {
    await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: false,
    }).catch(() => {});
    throw error;
  }
}

export async function finalizeReflectionMemoryWorktreeLaunch(params: {
  worktree: ReflectionMemoryWorktree;
  subagentSuccess: boolean;
  subagentError?: string;
  agentId: string;
  conversationId: string;
  subagentAgentId?: string;
  subagentType?: "reflection";
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  logRecompileFailure?: (message: string) => void;
}): Promise<{
  integration: ReflectionMemoryWorktreeFinalizeResult;
  completionSuccess: boolean;
  completionMessage: string;
}> {
  const integration = await finalizeReflectionMemoryWorktree(params.worktree, {
    shouldMerge: params.subagentSuccess,
  });
  const completionSuccess =
    params.subagentSuccess &&
    reflectionIntegrationConsumesTranscript(integration);

  if (reflectionIntegrationNeedsReminder(integration)) {
    queueReflectionIntegrationReminder({
      agentId: params.agentId,
      conversationId: params.conversationId,
      integration,
    });
  }

  const completionMessage = await handleMemorySubagentCompletion(
    {
      agentId: params.agentId,
      conversationId: params.conversationId,
      subagentType: params.subagentType ?? "reflection",
      success: completionSuccess,
      error: completionSuccess ? undefined : params.subagentError,
      subagentAgentId: params.subagentAgentId,
      skipRecompile: !reflectionIntegrationShouldRecompile(integration),
      successMessageOverride: getReflectionCompletionMessage(integration),
    },
    {
      recompileByConversation: params.recompileByConversation,
      recompileQueuedByConversation: params.recompileQueuedByConversation,
      logRecompileFailure: params.logRecompileFailure,
    },
  );

  return { integration, completionSuccess, completionMessage };
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
    if (reservedReflectionAgentIds.has(agentId)) {
      queuePendingReflectionLaunch(options);
    }
    return { launched: false, reason: "already_active" };
  }

  let releaseOnComplete = false;
  let preparedWorktree: ReflectionMemoryWorktree | undefined;
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

    const { worktree, reflectionPrompt } =
      await prepareReflectionMemoryWorktreeLaunch({
        agentId,
        instruction: options.instruction,
      });
    preparedWorktree = worktree;

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
      memoryScope: buildReflectionMemoryScope(worktree),
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
          const completionConversationId = resolveCompletionConversationId(
            options.completionConversationId,
            conversationId,
          );
          const { completionSuccess, completionMessage } =
            await finalizeReflectionMemoryWorktreeLaunch({
              worktree,
              subagentSuccess: success,
              subagentError: error,
              agentId,
              conversationId: completionConversationId,
              subagentAgentId: reflectionAgentId ?? undefined,
              recompileByConversation,
              recompileQueuedByConversation,
              logRecompileFailure: (message) => debugWarn("memory", message),
            });

          await finalizeAutoReflectionPayload(
            agentId,
            conversationId,
            autoPayload.payloadPath,
            autoPayload.endSnapshotLine,
            completionSuccess,
          );
          await onCompletionMessage?.(completionMessage, {
            success: completionSuccess,
            error,
            reflectionAgentId: reflectionAgentId ?? undefined,
          });
        } finally {
          releaseReflectionLaunch(agentId);
        }
      },
    });
    releaseOnComplete = true;
    preparedWorktree = undefined;
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
    if (!releaseOnComplete && preparedWorktree) {
      await finalizeReflectionMemoryWorktree(preparedWorktree, {
        shouldMerge: false,
      }).catch(() => {});
    }
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
