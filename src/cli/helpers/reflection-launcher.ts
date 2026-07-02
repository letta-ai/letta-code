import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  integratePendingReflectionMemoryWorktrees,
  type ReflectionMemoryWorktree,
  type ReflectionMemoryWorktreeFinalizeResult,
  reflectionIntegrationConsumesTranscript,
  reflectionIntegrationNeedsReminder,
  reflectionIntegrationShouldRecompile,
} from "@/agent/memory-worktree";
import { getSubagents } from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import type { ReflectionTrigger } from "@/cli/helpers/memory-reminder";
import {
  handleMemorySubagentCompletion,
  type MemorySubagentSuccessMessageOverride,
} from "@/cli/helpers/memory-subagent-completion";
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
  skipPendingWorktreeReminderScan?: boolean;
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
): MemorySubagentSuccessMessageOverride | undefined {
  switch (integration.status) {
    case "merged":
      return undefined;
    case "no_changes":
      return ({ action }) =>
        `${action}; no durable memory changes were needed.`;
    case "pending_conflict":
      return ({ action }) =>
        `${action}; memory merge will finish after conflicts are resolved.`;
    case "pending_manual_merge":
      return ({ action }) =>
        `${action}; memory merge will finish after pending memory changes are resolved.`;
    case "dirty_uncommitted":
      return "Tried to reflect, but memory changes were not committed cleanly; will retry later.";
    case "failed":
      return "Tried to reflect, but memory updates were not completed cleanly; will retry later.";
  }
}

function escapeTaskNotificationSummary(summary: string): string {
  return summary
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatReflectionIntegrationNotification(reminder: string): string {
  return `<task-notification>
<summary>${escapeTaskNotificationSummary(
    "Memory reflection merge is pending.",
  )}</summary>
<result>
${reminder}
</result>
</task-notification>`;
}

export function formatReflectionIntegrationReminder(
  integration: ReflectionMemoryWorktreeFinalizeResult,
): string {
  const resolveCommands = `cd ${JSON.stringify(integration.parentMemoryDir)}
git status
reflection_branch=${JSON.stringify(integration.reflectionBranch)}
reflection_subject=$(git log -1 --pretty=%s "$reflection_branch")
reflection_summary=$(printf '%s' "$reflection_subject" | sed -E 's/^[a-z]+(\\([^)]+\\))?!?:[[:space:]]*//I')
merge_message="merge(reflection): \${reflection_summary:-reflection memory updates}"
# If parent MemFS has unrelated changes, inspect changes, then commit or discard them.
# Then merge the reflection branch and resolve conflicts if prompted:
git merge "$reflection_branch" -m "$merge_message" || {
  git status
  echo "Resolve conflicted memory files, then stage specific resolved files and run: git commit --no-edit"
  exit 1
}

git worktree remove ${JSON.stringify(integration.reflectionWorktreeDir)}
git branch -d "$reflection_branch"`;

  const reminder = `${SYSTEM_REMINDER_OPEN}
BACKGROUND MEMORY MAINTENANCE: A reflection memory merge is pending.

A background reflection completed and produced committed memory updates, but the harness could not merge them into your main MemFS automatically.

Do not interrupt the user's current request just because of this reminder, and do not invoke a skill solely because this reminder arrived. If you are already responding to the user, finish that response first. Resolve this later when appropriate, or when the user asks you to handle pending memory merges.

Parent memory dir: ${integration.parentMemoryDir}
Reflection branch: ${integration.reflectionBranch}
Reflection worktree: ${integration.reflectionWorktreeDir}
Status: ${integration.summary}

When you decide to resolve it, use standard git commands like:
\`\`\`bash
${resolveCommands}
\`\`\`

This reminder is one-time. The transcript was already reflected, so do not launch another reflection for the same content just to resolve this merge.
${SYSTEM_REMINDER_CLOSE}`;
  return formatReflectionIntegrationNotification(reminder);
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

export async function queuePendingReflectionWorktreeReminders(params: {
  agentId: string;
  conversationId: string;
}): Promise<void> {
  const memoryDir = getScopedMemoryFilesystemRoot(params.agentId);
  const unresolvedIntegrations =
    await integratePendingReflectionMemoryWorktrees(memoryDir);
  for (const integration of unresolvedIntegrations) {
    queueReflectionIntegrationReminder({
      agentId: params.agentId,
      conversationId: params.conversationId,
      integration,
    });
  }
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

  if (
    triggerSource === "compaction-event" &&
    !options.skipPendingWorktreeReminderScan
  ) {
    try {
      await queuePendingReflectionWorktreeReminders({
        agentId,
        conversationId,
      });
    } catch (error) {
      debugWarn(
        "memory",
        "Failed to queue pending reflection worktree reminders after compaction:",
        error instanceof Error ? error.message : String(error),
      );
    }
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
