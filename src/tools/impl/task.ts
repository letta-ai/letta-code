/**
 * Task tool implementation
 *
 * Spawns specialized subagents to handle complex, multi-step tasks autonomously.
 * Supports both built-in subagent types and custom subagents defined in .letta/agents/.
 */

import { ACTING_USER_ID_ENV } from "@/agent/acting-user";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import type { ModelReasoningEffort } from "@/agent/model";
import { parseReasoningEffort } from "@/agent/model";
import {
  completeSubagent,
  generateSubagentId,
  getSnapshot as getSubagentSnapshot,
  getSubagentToolCount,
  registerSubagent,
} from "@/agent/subagent-state.js";
import {
  clearSubagentConfigCache,
  discoverSubagents,
  getAllSubagentConfigs,
  type SubagentConfig,
  type SubagentMemoryScope,
  type SubagentResult,
} from "@/agent/subagents";
import { forkParentConversation } from "@/agent/subagents/fork-conversation";
import { spawnSubagent } from "@/agent/subagents/manager";
import { getBackend } from "@/backend";
import { runSubagentStopHooks } from "@/hooks";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import type {
  SubagentLaunchArgs,
  SubagentLaunchResult,
} from "@/types/subagent-protocol";
import { addToMessageQueue } from "@/utils/message-queue-bridge.js";
import { sleep } from "@/utils/sleep";
import {
  formatTaskNotification,
  resolveNotificationScope,
} from "@/utils/task-notifications.js";
import { copyGitHubPullRequestTags } from "./github-pull-request-tracker.js";
import { runBackgroundMemoryTask } from "./memory-task-lifecycle";
import {
  appendToOutputFile,
  assertBackgroundTaskCapacity,
  type BackgroundTask,
  backgroundTasks,
  createBackgroundOutputFile,
  getNextTaskId,
  scheduleBackgroundTaskCleanup,
} from "./process_manager.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation";

interface TaskArgs extends Partial<SubagentLaunchArgs> {
  command?: "run" | "refresh";
  toolCallId?: string; // Injected by executeTool for linking subagent to parent tool call
  signal?: AbortSignal; // Injected by executeTool for interruption handling
  parentScope?: { agentId: string; conversationId: string }; // Injected by executeTool for notification routing
}

// Valid subagent_types when deploying an existing agent
const VALID_DEPLOY_TYPES = new Set(["general-purpose"]);
const BACKGROUND_STARTUP_POLL_MS = 50;

export interface SpawnBackgroundSubagentTaskArgs {
  subagentType: string;
  /** Configuration resolved by the caller; omitted by legacy internal callers. */
  config?: SubagentConfig;
  /** User-facing task type; execution still uses subagentType. */
  displayType?: string;
  prompt: string;
  description: string;
  model?: string;
  /** Reasoning effort override applied on top of the model's own settings. */
  reasoningEffort?: ModelReasoningEffort;
  /** Replace the subagent's configured system prompt/persona (advanced). */
  systemPromptOverride?: string;
  toolCallId?: string;
  existingAgentId?: string;
  existingConversationId?: string;
  /** Identity for this child's initial input only. */
  clientMessageId?: string;
  maxTurns?: number;
  forkedContext?: boolean;
  /** Parent conversation scope for routing notifications in listener mode. */
  parentScope?: { agentId: string; conversationId: string };
  /** Authenticated Cloud user responsible for the launch-time turn. */
  actingUserId?: string;
  /** Transcript/payload file exposed as TRANSCRIPT_PATH for reflection prompts. */
  transcriptPath?: string;
  /** Optional exact memory scope for harness-created memory worktrees. */
  memoryScope?: SubagentMemoryScope;
  /**
   * Optional computer selector passed to the child as `--computer`.
   * The child routes its turn to that connected computer and fails fast
   * if the device is offline, ambiguous, or too old to support routing.
   */
  environment?: string;
  /**
   * When true, skip injecting the completion notification into the primary
   * agent's message queue and hide from SubagentGroupDisplay.
   * Use `onComplete` to show a user-facing notification without leaking
   * into the agent's context.
   */
  silentCompletion?: boolean;
  /**
   * Emit a completion notification even when `silentCompletion` is true.
   * Useful when the parent should not stream subagent tokens but still wants
   * a normal task notification event.
   */
  emitCompletionNotification?: boolean;
  /**
   * Optional override for the completion notification summary.
   */
  completionSummary?:
    | string
    | ((result: {
        success: boolean;
        error?: string;
      }) => string | Promise<string>);
  /**
   * Called after the subagent finishes (success or failure).
   * Runs regardless of `silentCompletion` and is awaited before
   * completion notifications/hooks continue.
   * `report` is the raw final subagent report and may be large; callbacks
   * should parse/summarize it rather than injecting it directly into context.
   */
  onComplete?: (result: {
    success: boolean;
    error?: string;
    agentId?: string;
    conversationId?: string;
    model?: string;
    stepCount?: number;
    durationMs?: number;
    report?: string;
  }) => void | Promise<void>;
  /**
   * Optional dependency overrides for tests.
   * Production callers should not provide this.
   */
  deps?: Partial<SpawnBackgroundSubagentTaskDeps>;
}

export interface SpawnBackgroundSubagentTaskResult {
  taskId: string;
  outputFile: string;
  subagentId: string;
}

interface SpawnBackgroundSubagentTaskDeps {
  spawnSubagentImpl: typeof spawnSubagent;
  copyGitHubPullRequestTagsImpl: typeof copyGitHubPullRequestTags;
  addToMessageQueueImpl: typeof addToMessageQueue;
  formatTaskNotificationImpl: typeof formatTaskNotification;
  runSubagentStopHooksImpl: typeof runSubagentStopHooks;
  generateSubagentIdImpl: typeof generateSubagentId;
  registerSubagentImpl: typeof registerSubagent;
  completeSubagentImpl: typeof completeSubagent;
  getSubagentSnapshotImpl: typeof getSubagentSnapshot;
}

async function resolveCompletionSummary(
  defaultSummary: string,
  completionSummary:
    | SpawnBackgroundSubagentTaskArgs["completionSummary"]
    | undefined,
  result: { success: boolean; error?: string },
): Promise<string> {
  if (!completionSummary) {
    return defaultSummary;
  }

  const resolved =
    typeof completionSummary === "function"
      ? await completionSummary(result)
      : completionSummary;

  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : defaultSummary;
}

function buildTaskResultHeader(
  subagentType: string,
  subagentId: string,
  result?: Pick<SubagentResult, "agentId" | "conversationId">,
  status?: "success" | "error",
): string {
  return [
    `subagent_type=${subagentType}`,
    `subagent_id=${subagentId}`,
    status ? `subagent_status=${status}` : undefined,
    result?.agentId ? `agent_id=${result.agentId}` : undefined,
    result?.conversationId
      ? `conversation_id=${result.conversationId}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function writeTaskTranscriptStart(
  outputFile: string,
  description: string,
  subagentType: string,
): void {
  appendToOutputFile(
    outputFile,
    `[Task started: ${description}]\n[subagent_type: ${subagentType}]\n\n`,
  );
}

function writeTaskTranscriptResult(
  outputFile: string,
  result: SubagentResult,
  header: string,
  options: { reportAlreadyWritten?: boolean } = {},
): void {
  if (result.success) {
    const report = options.reportAlreadyWritten ? "" : `${result.report}\n\n`;
    appendToOutputFile(outputFile, `${header}\n\n${report}[Task completed]\n`);
    return;
  }

  appendToOutputFile(
    outputFile,
    `${header ? `${header}\n\n` : ""}[error] ${result.error || "Subagent execution failed"}\n\n[Task failed]\n`,
  );
}

/**
 * Wait briefly for a background subagent to publish its agent URL.
 * This keeps Task mostly non-blocking while allowing static transcript rows
 * to include an ADE link in the common case.
 */
export async function waitForBackgroundSubagentLink(
  subagentId: string,
  timeoutMs: number | null = null,
  signal?: AbortSignal,
): Promise<void> {
  const deadline =
    timeoutMs !== null && timeoutMs > 0 ? Date.now() + timeoutMs : null;

  while (true) {
    if (signal?.aborted) {
      return;
    }

    const agent = getSubagentSnapshot().agents.find((a) => a.id === subagentId);
    if (!agent) {
      return;
    }
    if (agent.agentURL || agent.conversationId) {
      return;
    }
    if (agent.status === "error" || agent.status === "completed") {
      return;
    }
    if (deadline !== null && Date.now() >= deadline) {
      return;
    }

    await sleep(BACKGROUND_STARTUP_POLL_MS);
  }
}

export async function waitForBackgroundSubagentAgentId(
  subagentId: string,
  timeoutMs: number | null = null,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline =
    timeoutMs !== null && timeoutMs > 0 ? Date.now() + timeoutMs : null;

  while (true) {
    if (signal?.aborted) {
      return null;
    }

    const agent = getSubagentSnapshot().agents.find((a) => a.id === subagentId);
    if (!agent) {
      return null;
    }
    if (agent.agentId) {
      return agent.agentId;
    }
    if (agent.status === "error" || agent.status === "completed") {
      return agent.agentId ?? null;
    }
    if (deadline !== null && Date.now() >= deadline) {
      return agent.agentId ?? null;
    }

    await sleep(BACKGROUND_STARTUP_POLL_MS);
  }
}

export async function waitForBackgroundSubagentConversationId(
  subagentId: string,
  timeoutMs: number | null = null,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline =
    timeoutMs !== null && timeoutMs > 0 ? Date.now() + timeoutMs : null;

  while (true) {
    if (signal?.aborted) {
      return null;
    }

    const agent = getSubagentSnapshot().agents.find((a) => a.id === subagentId);
    if (!agent) {
      return null;
    }
    if (agent.conversationId) {
      return agent.conversationId;
    }
    if (agent.status === "error" || agent.status === "completed") {
      return agent.conversationId ?? null;
    }
    if (deadline !== null && Date.now() >= deadline) {
      return agent.conversationId ?? null;
    }

    await sleep(BACKGROUND_STARTUP_POLL_MS);
  }
}

/**
 * Spawn a background subagent task and return task metadata immediately.
 * Notification/hook behavior is identical to Task's background path.
 */
export function spawnBackgroundSubagentTask(
  args: SpawnBackgroundSubagentTaskArgs,
): SpawnBackgroundSubagentTaskResult {
  if (args.subagentType === "memory" && args.environment?.trim()) {
    throw new Error(
      "Memory workers must run on the current machine; omit computer.",
    );
  }
  assertBackgroundTaskCapacity();

  const {
    subagentType,
    displayType,
    prompt,
    description,
    model,
    reasoningEffort,
    systemPromptOverride,
    toolCallId,
    existingAgentId,
    existingConversationId,
    maxTurns,
    forkedContext,
    parentScope,
    actingUserId: explicitActingUserId,
    silentCompletion: requestedSilentCompletion,
    emitCompletionNotification,
    completionSummary,
    onComplete,
    transcriptPath,
    memoryScope,
    environment,
    deps,
  } = args;
  const silentCompletion =
    subagentType === "memory" || requestedSilentCompletion;
  const shouldEmitCompletionNotification =
    subagentType !== "memory" &&
    (emitCompletionNotification ?? !silentCompletion);

  const resolvedParentScope = resolveNotificationScope(parentScope);
  const actingUserId =
    explicitActingUserId ??
    getRuntimeContext()?.actingUserId ??
    process.env[ACTING_USER_ID_ENV];

  const spawnSubagentFn = deps?.spawnSubagentImpl ?? spawnSubagent;
  const copyGitHubPullRequestTagsFn =
    deps?.copyGitHubPullRequestTagsImpl ?? copyGitHubPullRequestTags;
  const addToMessageQueueFn = deps?.addToMessageQueueImpl ?? addToMessageQueue;
  const formatTaskNotificationFn =
    deps?.formatTaskNotificationImpl ?? formatTaskNotification;
  const runSubagentStopHooksFn =
    deps?.runSubagentStopHooksImpl ?? runSubagentStopHooks;
  const generateSubagentIdFn =
    deps?.generateSubagentIdImpl ?? generateSubagentId;
  const registerSubagentFn = deps?.registerSubagentImpl ?? registerSubagent;
  const completeSubagentFn = deps?.completeSubagentImpl ?? completeSubagent;
  const getSubagentSnapshotFn =
    deps?.getSubagentSnapshotImpl ?? getSubagentSnapshot;

  const subagentId = generateSubagentIdFn();
  registerSubagentFn(
    subagentId,
    displayType ?? subagentType,
    description,
    toolCallId,
    true,
    silentCompletion,
    resolvedParentScope,
    prompt,
  );

  const taskId = getNextTaskId();
  const outputFile = createBackgroundOutputFile(taskId);
  const abortController = new AbortController();

  const bgTask: BackgroundTask = {
    description,
    subagentType,
    displayType,
    subagentId,
    status: "running",
    startTime: new Date(),
    outputFile,
    abortController,
    runtimeScope: resolvedParentScope,
    actingUserId,
  };
  backgroundTasks.set(taskId, bgTask);
  writeTaskTranscriptStart(outputFile, description, subagentType);

  // Intentionally fire-and-forget: background tasks own their lifecycle and
  // capture failures in task state/transcripts instead of surfacing a promise
  // back to the caller.
  //
  // Capture parentAgentId synchronously here (not inside spawnSubagent, which
  // runs after async yields and can see a drifted in-process context if the
  // listener is processing another agent's turn). resolvedParentScope.agentId
  // is the authoritative value — the listener and App.tsx both derive it
  // from their own closure-captured agentId.
  const parentAgentIdForSpawn = resolvedParentScope?.agentId;
  const workerMemoryDir =
    subagentType === "memory" && resolvedParentScope
      ? (memoryScope?.primaryRoot ??
        getScopedMemoryFilesystemRoot(resolvedParentScope.agentId))
      : undefined;
  const effectiveMemoryScope =
    memoryScope ??
    (workerMemoryDir
      ? { primaryRoot: workerMemoryDir, writableRoots: [workerMemoryDir] }
      : undefined);
  const execute = (
    assignment = prompt,
    parentTranscript = transcriptPath,
    scope = effectiveMemoryScope,
  ) => {
    return spawnSubagentFn(
      subagentType,
      assignment,
      model,
      subagentId,
      abortController.signal,
      existingAgentId,
      existingConversationId,
      maxTurns,
      forkedContext,
      parentAgentIdForSpawn,
      parentTranscript,
      resolvedParentScope?.conversationId,
      scope,
      systemPromptOverride,
      environment,
      actingUserId,
      args.config,
      args.clientMessageId,
      reasoningEffort,
    );
  };
  const memoryTask =
    subagentType === "memory" && resolvedParentScope && workerMemoryDir
      ? runBackgroundMemoryTask({
          ...resolvedParentScope,
          memoryDir: workerMemoryDir,
          assignment: prompt,
          signal: abortController.signal,
          subagentId,
          outputFile,
          formatHeader: (identity) =>
            buildTaskResultHeader(subagentType, subagentId, identity),
          execute,
          getSnapshot: getSubagentSnapshotFn,
        })
      : undefined;
  const unsubscribe = memoryTask?.unsubscribe ?? (() => {});
  const subagentExecution =
    memoryTask?.execution ??
    (subagentType === "memory"
      ? Promise.reject(
          new Error("Memory tasks require a parent conversation scope"),
        )
      : execute());
  const taskLifecycle = subagentExecution
    .then(async (result) => {
      await copyGitHubPullRequestTagsFn(
        result.conversationId,
        resolvedParentScope?.conversationId,
      );

      bgTask.status = result.success ? "completed" : "failed";
      if (result.error) {
        bgTask.error = result.error;
      }

      const header = buildTaskResultHeader(
        subagentType,
        subagentId,
        result,
        result.success ? "success" : "error",
      );
      writeTaskTranscriptResult(outputFile, result, header, {
        reportAlreadyWritten: memoryTask !== undefined,
      });
      scheduleBackgroundTaskCleanup(taskId);

      completeSubagentFn(subagentId, {
        success: result.success,
        error: result.error,
        totalTokens: result.totalTokens,
      });

      try {
        await onComplete?.({
          success: result.success,
          error: result.error,
          agentId: result.agentId,
          conversationId: result.conversationId,
          model: result.model,
          stepCount: result.stepCount,
          durationMs: result.durationMs,
          report: result.report,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        appendToOutputFile(outputFile, `[onComplete error] ${errorMessage}\n`);
      }

      if (shouldEmitCompletionNotification) {
        const subagentSnapshot = getSubagentSnapshotFn();
        const subagentEntry = subagentSnapshot.agents.find(
          (agent) => agent.id === subagentId,
        );
        const durationMs = Math.max(0, Date.now() - bgTask.startTime.getTime());

        const fullResult = result.success
          ? `${header}\n\n${result.report || ""}`
          : `${header}\n\nError: ${result.error || "Subagent execution failed"}`;
        const userCwd = getCurrentWorkingDirectory();
        const { content: truncatedResult } = truncateByChars(
          fullResult,
          LIMITS.TASK_OUTPUT_CHARS,
          "Task",
          { workingDirectory: userCwd },
        );

        const defaultSummary = `Agent "${description}" ${result.success ? "completed" : "failed"}`;
        const summary = await resolveCompletionSummary(
          defaultSummary,
          completionSummary,
          { success: result.success, error: result.error },
        );

        const notificationXml = formatTaskNotificationFn({
          taskId,
          status: result.success ? "completed" : "failed",
          summary,
          result: truncatedResult,
          outputFile,
          usage: {
            totalTokens: result.totalTokens,
            toolUses:
              subagentEntry === undefined
                ? undefined
                : getSubagentToolCount(subagentEntry),
            durationMs,
          },
        });
        addToMessageQueueFn({
          kind: "task_notification",
          text: notificationXml,
          agentId: resolvedParentScope?.agentId,
          conversationId: resolvedParentScope?.conversationId,
          actingUserId: bgTask.actingUserId,
        });
      }

      runSubagentStopHooksFn(
        subagentType,
        subagentId,
        result.success,
        result.error,
        result.agentId,
        result.conversationId,
      ).catch(() => {
        // Silently ignore hook errors
      });
    })
    .catch(async (error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      bgTask.status = "failed";
      bgTask.error = errorMessage;
      appendToOutputFile(
        outputFile,
        `[error] ${errorMessage}\n\n[Task failed]\n`,
      );
      scheduleBackgroundTaskCleanup(taskId);
      completeSubagentFn(subagentId, { success: false, error: errorMessage });

      try {
        await onComplete?.({
          success: false,
          error: errorMessage,
          agentId: existingAgentId,
          conversationId: existingConversationId,
        });
      } catch (onCompleteError) {
        const callbackMessage =
          onCompleteError instanceof Error
            ? onCompleteError.message
            : String(onCompleteError);
        appendToOutputFile(
          outputFile,
          `[onComplete error] ${callbackMessage}\n`,
        );
      }

      if (shouldEmitCompletionNotification) {
        const subagentSnapshot = getSubagentSnapshotFn();
        const subagentEntry = subagentSnapshot.agents.find(
          (agent) => agent.id === subagentId,
        );
        const durationMs = Math.max(0, Date.now() - bgTask.startTime.getTime());
        const header = buildTaskResultHeader(
          subagentType,
          subagentId,
          {
            agentId: existingAgentId ?? "",
            conversationId: existingConversationId,
          },
          "error",
        );
        const defaultSummary = `Agent "${description}" failed`;
        const summary = await resolveCompletionSummary(
          defaultSummary,
          completionSummary,
          { success: false, error: errorMessage },
        );

        const notificationXml = formatTaskNotificationFn({
          taskId,
          status: "failed",
          summary,
          result: `${header}\n\nError: ${errorMessage}`,
          outputFile,
          usage: {
            toolUses:
              subagentEntry === undefined
                ? undefined
                : getSubagentToolCount(subagentEntry),
            durationMs,
          },
        });
        addToMessageQueueFn({
          kind: "task_notification",
          text: notificationXml,
          agentId: resolvedParentScope?.agentId,
          conversationId: resolvedParentScope?.conversationId,
          actingUserId: bgTask.actingUserId,
        });
      }

      runSubagentStopHooksFn(
        subagentType,
        subagentId,
        false,
        errorMessage,
        existingAgentId,
        existingConversationId,
      ).catch(() => {
        // Silently ignore hook errors
      });
    })
    .finally(unsubscribe);

  bgTask.completion =
    subagentType === "memory"
      ? taskLifecycle
      : subagentExecution.then(
          () => undefined,
          () => undefined,
        );
  return { taskId, outputFile, subagentId };
}

/** Launch through the same task lifecycle for tools and App Server commands. */
export async function launchSubagent(
  args: TaskArgs,
): Promise<SubagentLaunchResult> {
  const { model, toolCallId, signal } = args;
  if (
    args.client_message_id !== undefined &&
    (typeof args.client_message_id !== "string" ||
      !args.client_message_id.trim())
  )
    return {
      success: false,
      error: "client_message_id must be a non-empty string",
    };
  const resolvedParentScope = resolveNotificationScope(args.parentScope);
  signal?.throwIfAborted();

  // Determine if deploying an existing agent
  const isDeployingExisting = Boolean(args.agent_id || args.conversation_id);

  // Validate required parameters based on mode
  if (isDeployingExisting) {
    // Deploying existing agent: prompt and description required, subagent_type optional
    validateRequiredParams(args, ["prompt", "description"], "Task");
  } else {
    // Creating new agent: subagent_type, prompt, and description required
    validateRequiredParams(
      args,
      ["subagent_type", "prompt", "description"],
      "Task",
    );
  }

  // Extract validated params
  const inputPrompt = args.prompt as string;
  const description = args.description as string;

  // For existing agents, default subagent_type to "general-purpose" for permissions
  const subagent_type = isDeployingExisting
    ? args.subagent_type || "general-purpose"
    : (args.subagent_type as string);

  const prepared = subagent_type === "custom" && isDeployingExisting;
  const allConfigs = prepared
    ? {}
    : await getAllSubagentConfigs(getCurrentWorkingDirectory());
  const config: SubagentConfig | undefined = prepared
    ? {
        name: "custom",
        description: "Prepared conversation",
        systemPrompt: "",
        allowedTools: "all",
        recommendedModel: "inherit",
        skills: [],
        fork: false,
        launchProfile: "default",
      }
    : allConfigs[subagent_type];
  if (!config) {
    return {
      success: false,
      error: `Invalid subagent type "${subagent_type}". Available types: ${Object.keys(allConfigs).join(", ")}`,
    };
  }
  if (
    !prepared &&
    isDeployingExisting &&
    !VALID_DEPLOY_TYPES.has(subagent_type)
  ) {
    return {
      success: false,
      error: `When deploying an existing agent, subagent_type must be "general-purpose". Got: "${subagent_type}"`,
    };
  }
  if (
    prepared &&
    (!args.conversation_id ||
      args.conversation_id === "default" ||
      args.model !== undefined ||
      args.reasoning_effort !== undefined)
  ) {
    return {
      success: false,
      error:
        "custom requires a prepared conversation_id; configure its model and reasoning effort before launching.",
    };
  }
  if (
    args.max_turns !== undefined &&
    (!Number.isSafeInteger(args.max_turns) || args.max_turns <= 0)
  ) {
    return { success: false, error: "max_turns must be a positive integer" };
  }
  if (typeof args.computer === "string" && args.computer.trim()) {
    if (subagent_type === "memory") {
      return {
        success: false,
        error: "Memory workers must run on the current machine; omit computer.",
      };
    }
    let environmentRouting = false;
    try {
      environmentRouting = getBackend().capabilities.environmentRouting;
    } catch {
      environmentRouting = false;
    }
    if (!environmentRouting) {
      return {
        success: false,
        error:
          "The computer option requires a Letta Cloud backend. This backend has no connected computers; omit the computer field to run the subagent on the current machine.",
      };
    }
  }

  const parsedReasoningEffort = parseReasoningEffort(args.reasoning_effort);
  if (!parsedReasoningEffort.ok) {
    return {
      success: false,
      error: `Invalid reasoning_effort "${args.reasoning_effort}". ${parsedReasoningEffort.message}`,
    };
  }
  const reasoningEffort = parsedReasoningEffort.effort;

  let effectiveAgentId = args.agent_id;
  let effectiveConversationId = args.conversation_id;

  if (prepared && effectiveConversationId) {
    if (effectiveConversationId === resolvedParentScope?.conversationId) {
      return {
        success: false,
        error: "A subagent cannot run in its parent conversation",
      };
    }
    const child = await getBackend().retrieveConversation(
      effectiveConversationId,
      { signal },
    );
    if (args.agent_id && child.agent_id !== args.agent_id) {
      return {
        success: false,
        error: "agent_id does not own the child conversation",
      };
    }
    effectiveAgentId = child.agent_id ?? undefined;
  }

  if (config.fork && subagent_type !== "memory") {
    if (args.agent_id || args.conversation_id) {
      return {
        success: false,
        error:
          "Subagent type with fork: true cannot be combined with agent_id or conversation_id",
      };
    }
    try {
      const parentAgentId = resolvedParentScope?.agentId ?? getCurrentAgentId();
      const parentConvId =
        resolvedParentScope?.conversationId ?? getConversationId() ?? "default";
      const forkedConv = await forkParentConversation({
        backend: getBackend(),
        parentAgentId,
        parentConversationId: parentConvId,
        config,
        model,
        reasoningEffort,
        signal,
      });
      effectiveAgentId = parentAgentId;
      effectiveConversationId = forkedConv.id;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to fork parent conversation: ${errorMessage}`,
      };
    }
  }

  const prompt = inputPrompt;
  signal?.throwIfAborted();

  const { taskId, outputFile, subagentId } = spawnBackgroundSubagentTask({
    subagentType: subagent_type,
    config,
    prompt,
    description,
    model,
    reasoningEffort,
    toolCallId,
    existingAgentId: effectiveAgentId,
    existingConversationId: effectiveConversationId,
    maxTurns: args.max_turns,
    clientMessageId: args.client_message_id,
    forkedContext: subagent_type !== "memory" && config.fork,
    parentScope: resolvedParentScope,
    environment:
      typeof args.computer === "string" && args.computer.trim()
        ? args.computer.trim()
        : undefined,
  });

  if (subagent_type === "memory") {
    return {
      success: true,
      task_id: taskId,
      output_file: outputFile,
      agent_id: null,
      conversation_id: null,
    };
  }

  const abortStartup = () =>
    backgroundTasks.get(taskId)?.abortController?.abort(signal?.reason);
  signal?.addEventListener("abort", abortStartup, { once: true });
  try {
    if (signal?.aborted) abortStartup();
    await waitForBackgroundSubagentLink(subagentId, null, signal);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abortStartup);
  }

  // Extract Letta agent ID from subagent state (available after link resolves)
  const linkedAgent = getSubagentSnapshot().agents.find(
    (a) => a.id === subagentId,
  );
  if (linkedAgent?.status === "error") {
    return {
      success: false,
      error: backgroundTasks.get(taskId)?.error ?? "Subagent launch failed",
    };
  }
  return {
    success: true,
    task_id: taskId,
    output_file: outputFile,
    agent_id: linkedAgent?.agentId ?? effectiveAgentId ?? null,
    conversation_id:
      linkedAgent?.conversationId ?? effectiveConversationId ?? null,
  };
}

/** Agent's text adapter; App Server callers consume launchSubagent directly. */
export async function task(args: TaskArgs): Promise<string> {
  if (args.command === "refresh") {
    clearSubagentConfigCache();
    const { subagents, errors } = await discoverSubagents();
    const allConfigs = await getAllSubagentConfigs();
    for (const error of errors) {
      console.warn(`Subagent discovery error: ${error.path}: ${error.message}`);
    }
    const errorSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : "";
    return `Refreshed subagents list: found ${Object.keys(allConfigs).length} total (${subagents.length} custom)${errorSuffix}`;
  }
  const result = await launchSubagent(args);
  if (!result.success) return `Error: ${result.error}`;
  if (args.subagent_type === "memory") {
    return `Memory task running in background (${result.task_id}). No completion notification will be sent. Output file: ${result.output_file}`;
  }
  const agentIdLine = result.agent_id ? `\nAgent ID: ${result.agent_id}` : "";
  const conversationIdLine = result.conversation_id
    ? `\nConversation ID: ${result.conversation_id}`
    : "";
  return `Task running in background with task ID: ${result.task_id}${agentIdLine}${conversationIdLine}\nOutput file: ${result.output_file}\n\nYou will be notified automatically when this task completes — a <task-notification> message will be delivered with the result. No need to poll, sleep-wait, or check the output file. Just continue with your current work.`;
}
