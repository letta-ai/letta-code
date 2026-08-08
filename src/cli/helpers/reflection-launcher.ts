import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  buildReflectionIntegrationMemoryScope,
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  inspectReflectionMemoryWorktree,
  type ReflectionMemoryWorktree,
  type ReflectionMemoryWorktreeFinalizeResult,
  reflectionIntegrationConsumesTranscript,
  reflectionIntegrationShouldRecompile,
  reflectionMemoryParentHasChanges,
} from "@/agent/memory-worktree";
import { getSubagents } from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import {
  getReflectionSettings,
  type ReflectionSettings,
  type ReflectionTrigger,
  shouldFireStepCountTrigger,
} from "@/cli/helpers/memory-reminder";
import {
  handleMemorySubagentCompletion,
  type MemorySubagentSuccessMessageOverride,
} from "@/cli/helpers/memory-subagent-completion";
import {
  buildReflectionIntegrationConversationTitle,
  buildReflectionIntegrationPrompt,
} from "@/cli/helpers/reflection-integration";
import {
  buildAutoReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
  finalizeAutoReflectionPayload,
  getReflectionTranscriptState,
} from "@/cli/helpers/reflection-transcript";
import { type ReflectionWorktreeCleanupOutcome, telemetry } from "@/telemetry";
import { maybeSendReflectionThresholdFeedback } from "@/telemetry/reflection-threshold-feedback";
import { debugLog, debugWarn } from "@/utils/debug";

export const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";

export function getReflectionMergeLaunchOptions(agentId: string) {
  const settings = getReflectionSettings(agentId);
  return {
    mergePolicy: settings.merge ?? "auto",
    mergeInstructions: settings.mergeInstructions,
  } as const;
}

export function getReflectionFinalizationContext(agentId: string) {
  return {
    agentId,
    ...getReflectionMergeLaunchOptions(agentId),
  } as const;
}

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
  | "parent_dirty"
  | "no_payload"
  | "error";

export function getReflectionLaunchSkippedMessage(
  reason: ReflectionLaunchSkippedReason,
  surface: "cli" | "listener" = "cli",
): string | undefined {
  switch (reason) {
    case "already_active":
      return surface === "listener"
        ? "A reflection agent is already running for this conversation."
        : "A reflection agent is already running in the background.";
    case "memfs_disabled":
      return surface === "listener"
        ? "Reflection needs the memory filesystem to be enabled for this agent. Use /remember for a lightweight memory update instead."
        : "Memory filesystem is not enabled. Use /remember instead.";
    case "no_payload":
      return surface === "listener"
        ? "No new transcript content to reflect on for this conversation."
        : "No new transcript content to reflect on.";
    case "parent_dirty":
      return "Parent memory has uncommitted changes; commit or discard them before reflecting.";
    case "error":
      return undefined;
  }
}

export function drainReflectionTelemetry(): void {
  telemetry.drain().catch((error) => {
    debugWarn(
      "telemetry",
      `Failed to flush reflection telemetry: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export interface ReflectionFeedbackContext {
  parentAgentName?: string | null;
  parentAgentDescription?: string | null;
  surface?: string;
}

function getReflectionWorktreeCleanupOutcome(
  integration: ReflectionMemoryWorktreeFinalizeResult,
):
  | {
      outcome: ReflectionWorktreeCleanupOutcome;
      integrationStatus:
        | "parent_dirty"
        | "merge_conflict"
        | "dirty_uncommitted"
        | "failed";
    }
  | undefined {
  switch (integration.status) {
    case "parent_dirty":
      return { outcome: "parent_dirty", integrationStatus: "parent_dirty" };
    case "merge_conflict":
      return { outcome: "merge_conflict", integrationStatus: "merge_conflict" };
    case "dirty_uncommitted":
      return {
        outcome: "reflection_worktree_dirty",
        integrationStatus: "dirty_uncommitted",
      };
    case "failed":
      return { outcome: "subagent_failed", integrationStatus: "failed" };
    case "merged":
    case "no_changes":
      return undefined;
  }
}

export function emitReflectionRunStart(params: {
  triggerSource: ReflectionLaunchTriggerSource;
  subagentId?: string;
  conversationId: string;
  startMessageId?: string;
  endMessageId?: string;
  model?: string | null;
}): void {
  telemetry.trackReflectionStart(params.triggerSource, {
    subagentId: params.subagentId,
    conversationId: params.conversationId,
    startMessageId: params.startMessageId,
    endMessageId: params.endMessageId,
    model: params.model,
  });
  drainReflectionTelemetry();
}

export function emitReflectionRunEnd(params: {
  parentAgentId: string;
  triggerSource: ReflectionLaunchTriggerSource;
  success: boolean;
  subagentId?: string;
  conversationId: string;
  error?: string;
  stepCount?: number;
  durationMs?: number;
  model?: string | null;
  feedbackContext?: ReflectionFeedbackContext;
}): void {
  telemetry.trackReflectionEnd(params.triggerSource, params.success, {
    subagentId: params.subagentId,
    conversationId: params.conversationId,
    error: params.error,
    stepCount: params.stepCount,
    durationMs: params.durationMs,
    model: params.model,
  });
  drainReflectionTelemetry();
  maybeSendReflectionThresholdFeedback({
    parentAgentId: params.parentAgentId,
    parentAgentName: params.feedbackContext?.parentAgentName,
    parentAgentDescription: params.feedbackContext?.parentAgentDescription,
    reflectionSubagentId: params.subagentId,
    conversationId: params.conversationId,
    triggerSource: params.triggerSource,
    success: params.success,
    error: params.error,
    stepCount: params.stepCount,
    durationMs: params.durationMs,
    surface: params.feedbackContext?.surface,
    model: params.model,
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
  reflectionSettings?: ReflectionSettings;
  description: string;
  /** Explicit model for this reflection subagent, if requested by the caller. */
  model?: string;
  instruction?: string;
  /**
   * Replace the reflection task prompt entirely (advanced). The caller owns the
   * transcript/memory mechanics the default prompt provides ($TRANSCRIPT_PATH,
   * $MEMORY_DIR, the commit contract).
   */
  reflectionPromptOverride?: string;
  /** Replace the reflection subagent's system prompt/persona (advanced). */
  reflectionSystemPromptOverride?: string;
  completionConversationId?: string | (() => string);
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  onCompletionMessage?: (
    message: string,
    result: {
      success: boolean;
      error?: string;
      reflectionAgentId?: string;
      integrationConversationId?: string;
    },
  ) => void | Promise<void>;
  feedbackContext?: ReflectionFeedbackContext;
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

export async function shouldRunQueuedReflectionLaunch(
  options: ReflectionLaunchOptions,
  deps: {
    getTranscriptState?: typeof getReflectionTranscriptState;
    getSettings?: typeof getReflectionSettings;
  } = {},
): Promise<boolean> {
  if (options.triggerSource !== "step-count") {
    return true;
  }

  const settings =
    options.reflectionSettings ??
    (deps.getSettings ?? getReflectionSettings)(options.agentId);
  const readTranscriptState =
    deps.getTranscriptState ?? getReflectionTranscriptState;
  const transcriptState = await readTranscriptState(
    options.agentId,
    options.conversationId,
  );
  const shouldLaunch = shouldFireStepCountTrigger(
    transcriptState.steps_since_last_successful_reflection,
    settings,
  );

  if (!shouldLaunch) {
    debugLog(
      "memory",
      `Skipping queued reflection launch (${options.triggerSource}) because the trigger threshold is no longer met`,
    );
  }

  return shouldLaunch;
}

function schedulePendingReflectionLaunch(agentId: string): void {
  const pendingOptions = pendingReflectionLaunches.get(agentId);
  if (!pendingOptions) return;
  pendingReflectionLaunches.delete(agentId);

  queueMicrotask(() => {
    void (async () => {
      if (!(await shouldRunQueuedReflectionLaunch(pendingOptions))) {
        return;
      }
      await launchReflectionSubagent(pendingOptions);
    })().catch((error) => {
      debugWarn(
        "memory",
        `Failed to launch queued reflection (${pendingOptions.triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
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
): MemorySubagentSuccessMessageOverride | undefined {
  switch (integration.status) {
    case "merged":
      return undefined;
    case "no_changes":
      return ({ action }) =>
        `${action}; no durable memory changes were needed.`;
    case "parent_dirty":
      return "Tried to reflect, but parent memory had uncommitted changes; will retry later.";
    case "merge_conflict":
      return "Tried to reflect, but memory updates conflicted with newer changes; will retry later.";
    case "dirty_uncommitted":
      return "Tried to reflect, but memory changes were not committed cleanly; will retry later.";
    case "failed":
      return integration.failurePhase === "integration"
        ? `${integration.summary} Will retry later.`
        : "Tried to reflect, but memory updates were not completed cleanly; will retry later.";
  }
}

interface ReflectionIntegrationOutcome {
  success: boolean;
  error?: string;
  conversationId?: string;
}

type RunExplicitReflectionIntegration = typeof runExplicitReflectionIntegration;

async function runExplicitReflectionIntegration(params: {
  agentId: string;
  conversationId: string;
  worktree: ReflectionMemoryWorktree;
  instructions?: string;
  reflectionSubagentId?: string;
}): Promise<ReflectionIntegrationOutcome> {
  const {
    spawnBackgroundSubagentTask,
    waitForBackgroundSubagentConversationId,
  } = await import("@/tools/impl/task");
  return await new Promise<ReflectionIntegrationOutcome>((resolve) => {
    try {
      const { subagentId } = spawnBackgroundSubagentTask({
        subagentType: "general-purpose",
        displayType: "reflection integration",
        prompt: buildReflectionIntegrationPrompt({
          worktree: params.worktree,
          instructions: params.instructions,
          reflectionSubagentId: params.reflectionSubagentId,
        }),
        description: "Integrate reflection memory changes",
        existingAgentId: params.agentId,
        memoryScope: buildReflectionIntegrationMemoryScope(params.worktree),
        parentScope: {
          agentId: params.agentId,
          conversationId: params.conversationId,
        },
        silentCompletion: true,
        onComplete: (result) => {
          resolve({
            success: result.success,
            error: result.success
              ? undefined
              : (result.error ?? "Reflection integration did not complete"),
            conversationId: result.conversationId,
          });
        },
      });
      void waitForBackgroundSubagentConversationId(
        subagentId,
        REFLECTION_AGENT_ID_WAIT_MS,
      )
        .then(async (conversationId) => {
          if (!conversationId) return;
          await getBackend().updateConversation(conversationId, {
            summary: buildReflectionIntegrationConversationTitle(
              params.reflectionSubagentId,
            ),
          });
        })
        .catch((error) => {
          debugWarn(
            "memory",
            `Failed to title reflection integration conversation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    } catch (error) {
      resolve({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function prepareReflectionMemoryWorktreeLaunch(params: {
  agentId: string;
  instruction?: string;
  reflectionPromptOverride?: string;
}): Promise<{
  worktree: ReflectionMemoryWorktree;
  reflectionPrompt: string;
}> {
  const memoryDir = getScopedMemoryFilesystemRoot(params.agentId);
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: memoryDir,
  });
  try {
    // An override replaces the whole task prompt; the caller is then responsible
    // for referencing $TRANSCRIPT_PATH / $MEMORY_DIR, so we skip the (otherwise
    // wasted) parent-memory snapshot in that case.
    const reflectionPrompt =
      params.reflectionPromptOverride ??
      buildReflectionSubagentPrompt({
        instruction: params.instruction,
        parentMemory: await buildParentMemorySnapshot(worktree.worktreeDir),
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
  knownNoChanges?: boolean;
  model?: string | null;
  mergePolicy?: "auto" | "explicit";
  mergeInstructions?: string;
  runExplicitIntegration?: RunExplicitReflectionIntegration;
  updateIntegrationConversation?: (
    conversationId: string,
    body: { summary: string; archived: boolean },
  ) => Promise<unknown>;
  telemetryContext?: {
    triggerSource: ReflectionLaunchTriggerSource;
  };
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  logRecompileFailure?: (message: string) => void;
}): Promise<{
  integration: ReflectionMemoryWorktreeFinalizeResult;
  completionSuccess: boolean;
  completionMessage: string;
  integrationConversationId?: string;
}> {
  let integrationRun: ReflectionIntegrationOutcome | undefined;
  if (params.subagentSuccess && params.mergePolicy === "explicit") {
    const state = params.knownNoChanges
      ? { commitCount: 0, dirty: false }
      : await inspectReflectionMemoryWorktree(params.worktree);
    if (state.commitCount > 0 || state.dirty) {
      integrationRun = await (
        params.runExplicitIntegration ?? runExplicitReflectionIntegration
      )({
        agentId: params.agentId,
        conversationId: params.conversationId,
        worktree: params.worktree,
        instructions: params.mergeInstructions,
        reflectionSubagentId: params.subagentAgentId,
      });
    }
  }

  const integration = await finalizeReflectionMemoryWorktree(params.worktree, {
    shouldMerge: params.subagentSuccess,
    knownNoChanges: params.knownNoChanges,
    requireAlreadyMerged:
      params.mergePolicy === "explicit" && integrationRun !== undefined,
    failureSummary: integrationRun?.error
      ? `Reflection integration did not complete (${integrationRun.error}); the worktree was cleaned up so the transcript can be retried.`
      : undefined,
  });
  const completionSuccess =
    params.subagentSuccess &&
    reflectionIntegrationConsumesTranscript(integration);

  const cleanup = getReflectionWorktreeCleanupOutcome(integration);
  if (cleanup) {
    telemetry.trackReflectionWorktreeCleanup({
      outcome: cleanup.outcome,
      integration_status: cleanup.integrationStatus,
      trigger_source: params.telemetryContext?.triggerSource,
      subagent_id: params.subagentAgentId,
      conversation_id: params.conversationId,
      reflection_worktree_id: params.worktree.id,
      commit_count: integration.commitCount,
      model: params.model ?? undefined,
    });
    drainReflectionTelemetry();
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

  if (completionSuccess && integrationRun?.conversationId) {
    try {
      const body = {
        summary: buildReflectionIntegrationConversationTitle(
          params.subagentAgentId,
        ),
        archived: true,
      };
      if (params.updateIntegrationConversation) {
        await params.updateIntegrationConversation(
          integrationRun.conversationId,
          body,
        );
      } else {
        await getBackend().updateConversation(
          integrationRun.conversationId,
          body,
        );
      }
    } catch (error) {
      debugWarn(
        "memory",
        `Failed to archive reflection integration conversation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    integration,
    completionSuccess,
    completionMessage,
    integrationConversationId: integrationRun?.conversationId,
  };
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
  const reflectionSettings =
    options.reflectionSettings ?? getReflectionSettings(agentId);

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
    const memoryDir = getScopedMemoryFilesystemRoot(agentId);
    if (await reflectionMemoryParentHasChanges(memoryDir)) {
      debugLog(
        "memory",
        `Skipping reflection launch (${triggerSource}) because parent memory has uncommitted changes`,
      );
      releaseReflectionLaunch(agentId);
      return { launched: false, reason: "parent_dirty" };
    }

    const autoPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
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
        reflectionPromptOverride: options.reflectionPromptOverride,
      });
    preparedWorktree = worktree;

    const { spawnBackgroundSubagentTask, waitForBackgroundSubagentAgentId } =
      await import("@/tools/impl/task");

    // Defer `reflection_start` until the agent ID resolves (background, bounded by REFLECTION_AGENT_ID_WAIT_MS).
    const emitReflectionStart = (resolvedAgentId: string | null) => {
      emitReflectionRunStart({
        triggerSource,
        subagentId: resolvedAgentId ?? undefined,
        conversationId,
        startMessageId: autoPayload.startMessageId,
        endMessageId: autoPayload.endMessageId,
        model: options.model,
      });
    };

    const { subagentId } = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: reflectionPrompt,
      description,
      model: options.model,
      systemPromptOverride: options.reflectionSystemPromptOverride,
      silentCompletion: true,
      transcriptPath: autoPayload.payloadPath,
      memoryScope: buildReflectionMemoryScope(worktree),
      parentScope: { agentId, conversationId },
      onComplete: async ({
        success,
        error,
        agentId: reflectionAgentId,
        model: reflectionModel,
        stepCount,
        durationMs,
      }) => {
        try {
          emitReflectionRunEnd({
            parentAgentId: agentId,
            triggerSource,
            success,
            subagentId: reflectionAgentId ?? undefined,
            conversationId,
            error,
            stepCount,
            durationMs,
            model: reflectionModel,
            feedbackContext: options.feedbackContext,
          });
          const completionConversationId = resolveCompletionConversationId(
            options.completionConversationId,
            conversationId,
          );
          const {
            completionSuccess,
            completionMessage,
            integrationConversationId,
          } = await finalizeReflectionMemoryWorktreeLaunch({
            worktree,
            subagentSuccess: success,
            subagentError: error,
            agentId,
            conversationId: completionConversationId,
            subagentAgentId: reflectionAgentId ?? undefined,
            model: reflectionModel,
            mergePolicy: reflectionSettings.merge,
            mergeInstructions: reflectionSettings.mergeInstructions,
            telemetryContext: { triggerSource },
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
            integrationConversationId,
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
