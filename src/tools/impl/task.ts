import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  clearSubagentAbortHook,
  completeSubagent,
  generateSubagentId,
  getSnapshot as getSubagentSnapshot,
  getSubagentToolCount,
  registerSubagent,
  registerSubagentAbortHook,
  updateSubagent,
} from "@/agent/subagent-state.js";
import {
  clearSubagentConfigCache,
  discoverSubagents,
  getAllSubagentConfigs,
  type SubagentConfig,
  type SubagentMemoryScope,
} from "@/agent/subagents";
import {
  waitForBackgroundSubagentAgentId,
  waitForBackgroundSubagentLink,
} from "@/agent/subagents/background-link";
import { resolveEffectiveAgentId } from "@/agent/subagents/ephemeral-subagent";
import { forkParentConversation } from "@/agent/subagents/fork-conversation";
import { spawnSubagent } from "@/agent/subagents/manager";
import { formatSubagentError } from "@/agent/subagents/subagent-refusal";
import { getBackend } from "@/backend";
import type { AgentSandboxOptions } from "@/backend/api/environments";
import { runSubagentStopHooks } from "@/hooks";
import {
  getCurrentWorkingDirectory,
  getRuntimeActingUserAttribution,
} from "@/runtime-context";
import type {
  SubagentLaunchArgs,
  SubagentLaunchResult,
} from "@/types/subagent-protocol";
import { addToMessageQueue } from "@/utils/message-queue-bridge.js";
import {
  formatTaskNotification,
  resolveNotificationScope,
  subagentResultReminder,
  taskNotificationMessage,
} from "@/utils/task-notifications.js";
import {
  classifyExternalCodingAgentStartupError,
  createExternalCodingAgentConfig,
  resolveExternalCodingAgentMcpReminder,
  runExternalCodingAgent,
  validateExternalCodingAgentMcpOptions,
} from "./external-coding-agent";
import { prepareExternalWorkerPrompt } from "./external-fork-context";
import { validateForkPrompt } from "./fork-prompt";
import { copyGitHubPullRequestTags } from "./github-pull-request-tracker.js";
import {
  ensureMemoryRepair,
  runBackgroundMemoryTask,
} from "./memory-task-lifecycle";
import {
  appendToOutputFile,
  assertBackgroundTaskCapacity,
  type BackgroundTask,
  backgroundTasks,
  createBackgroundOutputFile,
  getNextTaskId,
  scheduleBackgroundTaskCleanup,
} from "./process_manager.js";
import { launchRemoteExternalCodingAgent } from "./remote-external-coding-agent";
import { resolveLaunchComputer } from "./subagent-computer";
import { buildBackgroundTaskAbortHook } from "./task-abort-hook.js";
import {
  applySubagentPreset,
  listSubagentTypes,
  preparedConversationConfig,
  resolveTaskAgentSelection,
  shouldForkTaskContext,
} from "./task-agent-selection";
import { parseTaskCloudOptions } from "./task-cloud-options";
import { recordTaskSummary, resolveTaskInput } from "./task-summary";
import {
  buildTaskResultHeader,
  closeTaskProgressLog,
  externalWorkerProgressListeners,
  openTaskProgressLog,
  serveTaskEvents,
  taskEventsFileFor,
  writeTaskTranscriptResult,
  writeTaskTranscriptStart,
} from "./task-transcript";
import { LIMITS, truncateByChars } from "./truncation.js";

interface TaskArgs extends Partial<SubagentLaunchArgs> {
  command?: "run" | "refresh";
  cloud?: unknown;
  toolCallId?: string;
  signal?: AbortSignal;
  parentScope?: { agentId: string; conversationId: string };
  notifyCaller?: boolean;
}
const BACKGROUND_SUBAGENT_STARTUP_TIMEOUT_MS = 60_000;

export {
  waitForBackgroundSubagentAgentId,
  waitForBackgroundSubagentConversationId,
  waitForBackgroundSubagentLink,
} from "@/agent/subagents/background-link";

export interface SpawnBackgroundSubagentTaskArgs {
  taskId?: string;
  subagentType: string;
  config?: SubagentConfig;
  displayType?: string;
  prompt: string;
  description: string;
  model?: string;
  systemPromptOverride?: string;
  toolCallId?: string;
  existingAgentId?: string;
  existingConversationId?: string;
  clientMessageId?: string;
  maxTurns?: number;
  forkedContext?: boolean;
  parentScope?: { agentId: string; conversationId: string };
  actingUserId?: string | null;
  transcriptPath?: string;
  memoryScope?: SubagentMemoryScope;
  environment?: string;
  cloudOptions?: AgentSandboxOptions;
  silentCompletion?: boolean;
  memoryRepairToken?: string;
  emitCompletionNotification?: boolean;
  claimsParentRuntime?: boolean;
  publishResult?: boolean;
  completionSummary?:
    | string
    | ((result: {
        success: boolean;
        error?: string;
      }) => string | Promise<string>);
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

export function spawnBackgroundSubagentTask(
  args: SpawnBackgroundSubagentTaskArgs,
): SpawnBackgroundSubagentTaskResult {
  if (args.subagentType === "memory" && args.environment?.trim()) {
    throw new Error(
      "Memory workers must run on the current machine; omit computer.",
    );
  }
  if (args.subagentType === "memory" && !args.memoryRepairToken) {
    throw new Error("Memory repair requires an attempt token");
  }
  assertBackgroundTaskCapacity();

  const {
    subagentType,
    displayType,
    prompt,
    description,
    model,
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
    publishResult,
    claimsParentRuntime,
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
    explicitActingUserId === undefined
      ? getRuntimeActingUserAttribution()
      : explicitActingUserId;

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
    claimsParentRuntime,
  );

  const taskId = args.taskId ?? getNextTaskId();
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
    remote: Boolean(environment),
    runtimeScope: resolvedParentScope,
    actingUserId,
  };
  backgroundTasks.set(taskId, bgTask);
  registerSubagentAbortHook(
    subagentId,
    buildBackgroundTaskAbortHook(taskId, abortController),
  );
  writeTaskTranscriptStart(outputFile, description, subagentType);
  openTaskProgressLog(subagentId, outputFile, resolvedParentScope?.agentId);
  if (publishResult) serveTaskEvents(subagentId);
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
      args.cloudOptions,
    );
  };
  const memoryTask =
    subagentType === "memory" && resolvedParentScope && workerMemoryDir
      ? runBackgroundMemoryTask({
          ...resolvedParentScope,
          memoryDir: workerMemoryDir,
          assignment: prompt,
          repairToken: args.memoryRepairToken as string,
          signal: abortController.signal,
          subagentId,
          outputFile,
          formatHeader: (identity) =>
            buildTaskResultHeader(subagentType, subagentId, identity),
          execute,
          repair: (result) =>
            ensureMemoryRepair(
              { ...resolvedParentScope, actingUserId, result },
              spawnBackgroundSubagentTask,
            ),
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
      closeTaskProgressLog(subagentId);
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
      writeTaskTranscriptResult(outputFile, result, header, !!memoryTask);
      scheduleBackgroundTaskCleanup(taskId);
      clearSubagentAbortHook(subagentId);

      completeSubagentFn(subagentId, {
        success: result.success,
        error: result.error,
        totalTokens: result.totalTokens,
        ...(publishResult ? { published: true } : {}),
        ...(publishResult && result.success
          ? {
              result: truncateByChars(
                result.report || "",
                LIMITS.TASK_OUTPUT_CHARS,
                "Task",
                { workingDirectory: getCurrentWorkingDirectory() },
              ).content,
            }
          : {}),
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
          : `${header}\n\n${formatSubagentError(result.error || "Subagent execution failed")}`;
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
          ...taskNotificationMessage(notificationXml),
          agentId: resolvedParentScope?.agentId,
          conversationId: resolvedParentScope?.conversationId,
          actingUserId: bgTask.actingUserId,
          clientMessageIds: resolvedParentScope?.clientMessageIds,
        });
      }

      runSubagentStopHooksFn(
        subagentType,
        subagentId,
        result.success,
        result.error,
        result.agentId,
        result.conversationId,
      ).catch(() => {});
    })
    .catch(async (error) => {
      closeTaskProgressLog(subagentId);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      bgTask.status = "failed";
      bgTask.error = errorMessage;
      appendToOutputFile(
        outputFile,
        `[error] ${errorMessage}\n\n[Task failed]\n`,
      );
      scheduleBackgroundTaskCleanup(taskId);
      clearSubagentAbortHook(subagentId);
      completeSubagentFn(subagentId, {
        success: false,
        error: errorMessage,
        ...(publishResult ? { published: true } : {}),
      });

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
          result: `${header}\n\n${formatSubagentError(errorMessage)}`,
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
          ...taskNotificationMessage(notificationXml),
          agentId: resolvedParentScope?.agentId,
          conversationId: resolvedParentScope?.conversationId,
          actingUserId: bgTask.actingUserId,
          clientMessageIds: resolvedParentScope?.clientMessageIds,
        });
      }

      runSubagentStopHooksFn(
        subagentType,
        subagentId,
        false,
        errorMessage,
        existingAgentId,
        existingConversationId,
      ).catch(() => {});
    })
    .finally(unsubscribe);

  const swallow = () => undefined;
  bgTask.completion =
    subagentType === "memory"
      ? taskLifecycle
      : subagentExecution.then(swallow, swallow);
  return { taskId, outputFile, subagentId };
}

export async function launchSubagent(
  args: TaskArgs,
  cloudSkillRepositories?: string[],
  timeoutMs = BACKGROUND_SUBAGENT_STARTUP_TIMEOUT_MS,
): Promise<SubagentLaunchResult> {
  const prepared =
    args.subagent_type === "custom" &&
    Boolean(args.agent_id || args.conversation_id);
  if (!prepared) args = applySubagentPreset(args);
  const resolvedSelection = resolveTaskAgentSelection(args);
  if ("error" in resolvedSelection)
    return { success: false, error: resolvedSelection.error };
  const { selection } = resolvedSelection;
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

  const isDeployingExisting = Boolean(args.agent_id || args.conversation_id);
  const configName =
    selection.kind === "external" ? selection.type : selection.subagentType;
  const requestedType = args.subagent_type
    ? `subagent_type "${configName}"`
    : configName;
  if (args.fork_context && isDeployingExisting) {
    return {
      success: false,
      error: "fork_context cannot be combined with agent_id or conversation_id",
    };
  }
  const externalCodingAgentType =
    selection.kind === "external" ? selection.type : null;
  const isExternalCodingAgent = externalCodingAgentType !== null;
  if (isExternalCodingAgent && isDeployingExisting) {
    return {
      success: false,
      error: `${requestedType} does not accept agent_id or conversation_id at launch; use SendAgentMessage with the synthetic agent ID for follow-up work`,
    };
  }
  if (args.mcp && !isExternalCodingAgent) {
    return {
      success: false,
      error: "mcp is only supported for claude-code and codex subagents",
    };
  }
  const mcpValidationError = validateExternalCodingAgentMcpOptions(args.mcp);
  if (mcpValidationError) return { success: false, error: mcpValidationError };

  const input = resolveTaskInput(args, shouldForkTaskContext(args));
  if ("error" in input) return { success: false, error: input.error };
  const { description, prompt: inputPrompt } = input;
  const allConfigs =
    prepared || isExternalCodingAgent
      ? {}
      : await getAllSubagentConfigs(getCurrentWorkingDirectory());
  const config: SubagentConfig | undefined = isExternalCodingAgent
    ? createExternalCodingAgentConfig(
        externalCodingAgentType,
        shouldForkTaskContext(args),
      )
    : prepared
      ? preparedConversationConfig()
      : allConfigs[configName];
  if (!config) {
    return {
      success: false,
      error: `Invalid subagent_type "${configName}". Available subagent types: ${listSubagentTypes(Object.keys(allConfigs))}. Omit subagent_type for the default agent.`,
    };
  }
  const promptError = validateForkPrompt(inputPrompt, Boolean(config.fork));
  if (promptError) return { success: false, error: promptError };
  if (
    prepared &&
    (!args.conversation_id ||
      args.conversation_id === "default" ||
      args.model !== undefined)
  ) {
    return {
      success: false,
      error:
        "custom requires a prepared conversation_id; configure its model before launching.",
    };
  }
  if (
    args.max_turns !== undefined &&
    (!Number.isSafeInteger(args.max_turns) || args.max_turns <= 0)
  ) {
    return { success: false, error: "max_turns must be a positive integer" };
  }
  const resolvedComputer = resolveLaunchComputer({
    requested: args.computer,
    subagentType: configName,
    config,
  });
  if (resolvedComputer.error) {
    return { success: false, error: resolvedComputer.error };
  }

  const cloud = parseTaskCloudOptions(resolvedComputer.computer, args.cloud);
  if ("error" in cloud) return { success: false, error: cloud.error };
  let effectiveAgentId = args.agent_id;
  let effectiveConversationId = args.conversation_id;
  const callerNotification = args.notifyCaller
    ? {
        emitCompletionNotification: false,
        publishResult: true,
        claimsParentRuntime: false,
      }
    : {};
  if (isExternalCodingAgent) {
    const parentAgentId = resolveEffectiveAgentId(
      resolvedParentScope?.agentId ?? getCurrentAgentId(),
    );
    if (!parentAgentId) {
      return {
        success: false,
        error: `${configName} requires a parent agent identity`,
      };
    }
    if (resolvedComputer.computer) {
      return launchRemoteExternalCodingAgent(
        {
          type: externalCodingAgentType,
          computer: resolvedComputer.computer,
          prompt: inputPrompt,
          forkContext: shouldForkTaskContext(args),
          description,
          model,
          mcp: args.mcp,
          cloudOptions: cloud.options,
          toolCallId,
          parentScope: {
            conversationId: getConversationId() ?? "default",
            ...resolvedParentScope,
            agentId: parentAgentId,
          },
          signal,
        },
        { spawn: spawnBackgroundSubagentTask },
      );
    }
    const worker = await prepareExternalWorkerPrompt({
      prompt: inputPrompt,
      forkContext: shouldForkTaskContext(args),
      parentAgentId,
      parentConversationId: resolvedParentScope?.conversationId,
      signal,
    });
    if ("error" in worker) return { success: false, error: worker.error };
    let mcpReminder: string | undefined;
    try {
      mcpReminder = await resolveExternalCodingAgentMcpReminder(
        parentAgentId,
        args.mcp,
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const { taskId, outputFile, subagentId } = spawnBackgroundSubagentTask({
      subagentType: configName,
      config,
      prompt: worker.prompt,
      description,
      model,
      toolCallId,
      parentScope: resolvedParentScope,
      ...callerNotification,
      deps: {
        spawnSubagentImpl: async (
          _type,
          prompt,
          model,
          workerSubagentId,
          childSignal,
        ) =>
          runExternalCodingAgent({
            type: externalCodingAgentType,
            taskId: [...backgroundTasks].find(
              ([, task]) => task.subagentId === workerSubagentId,
            )?.[0],
            prompt,
            description,
            model,
            parentAgentId,
            parentConversationId: resolvedParentScope?.conversationId,
            actingUserId: resolvedParentScope?.actingUserId,
            cwd: getCurrentWorkingDirectory(),
            cloudSkillRepositories,
            mcpReminder,
            signal: childSignal,
            onStarted: (agentId) =>
              updateSubagent(subagentId, { agentId, status: "running" }),
            ...externalWorkerProgressListeners(workerSubagentId),
          }),
      },
    });
    let agentId: string | null = null;
    const abortStartup = () =>
      backgroundTasks.get(taskId)?.abortController?.abort(signal?.reason);
    signal?.addEventListener("abort", abortStartup, { once: true });
    try {
      if (signal?.aborted) abortStartup();
      agentId = await waitForBackgroundSubagentAgentId(
        subagentId,
        timeoutMs,
        signal,
      );
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", abortStartup);
    }
    const failed = getSubagentSnapshot().agents.find(
      (a) => a.id === subagentId && a.status === "error",
    );
    if (args.notifyCaller && !agentId && failed) {
      const error = failed.error ?? `${configName} failed to start`;
      const code = classifyExternalCodingAgentStartupError(error);
      return { success: false, error, ...(code ? { error_code: code } : {}) };
    }
    return {
      success: true,
      task_id: taskId,
      output_file: outputFile,
      agent_id: agentId,
      conversation_id: null,
    };
  }

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

  if (config.fork) {
    if (args.agent_id || args.conversation_id) {
      return {
        success: false,
        error: `${requestedType} forks context and cannot be combined with agent_id or conversation_id`,
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

  signal?.throwIfAborted();

  const { taskId, outputFile, subagentId } = spawnBackgroundSubagentTask({
    subagentType: configName,
    config,
    prompt: inputPrompt,
    description,
    model,
    toolCallId,
    existingAgentId: effectiveAgentId,
    existingConversationId: effectiveConversationId,
    maxTurns: args.max_turns,
    clientMessageId: args.client_message_id,
    forkedContext: config.fork,
    parentScope: resolvedParentScope,
    ...callerNotification,
    environment: resolvedComputer.computer,
    cloudOptions: cloud.options,
  });

  const abortStartup = () =>
    backgroundTasks.get(taskId)?.abortController?.abort(signal?.reason);
  signal?.addEventListener("abort", abortStartup, { once: true });
  let linkedConversationId: string | null;
  try {
    if (signal?.aborted) abortStartup();
    linkedConversationId = await waitForBackgroundSubagentLink(
      subagentId,
      timeoutMs,
      signal,
    );
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abortStartup);
  }

  const linkedAgent = getSubagentSnapshot().agents.find(
    (a) => a.id === subagentId,
  );
  if (linkedAgent?.status === "error") {
    return {
      success: false,
      error: backgroundTasks.get(taskId)?.error ?? "Subagent launch failed",
    };
  }
  const conversationId =
    linkedConversationId ??
    linkedAgent?.conversationId ??
    effectiveConversationId ??
    null;
  if (!isDeployingExisting) void recordTaskSummary(conversationId, description);
  return {
    success: true,
    task_id: taskId,
    output_file: outputFile,
    agent_id: linkedAgent?.agentId ?? effectiveAgentId ?? null,
    conversation_id: conversationId,
  };
}
export async function task(
  args: TaskArgs,
): Promise<string | { content: string; status: "error" }> {
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
  const result = await launchSubagent(applySubagentPreset(args));
  if (!result.success)
    return { content: `Error: ${result.error}`, status: "error" };
  const agentIdLine = result.agent_id ? `\nAgent ID: ${result.agent_id}` : "";
  const conversationIdLine = result.conversation_id
    ? `\nConversation ID: ${result.conversation_id}`
    : "";
  return `Task running in background with task ID: ${result.task_id}${agentIdLine}${conversationIdLine}\nOutput file: ${result.output_file}\nEvent log: ${taskEventsFileFor(result.output_file)}\n\nYou will be notified automatically when this task completes — a <task-notification> message will be delivered with the result. No need to poll or sleep-wait; continue with your current work. To see what it is doing meanwhile, Read the output file: one line per tool call, tool result, and message, live. For exact details (full tool arguments and outputs, such as a command's error), read the event log.${subagentResultReminder()}`;
}
