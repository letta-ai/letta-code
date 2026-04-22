/**
 * Task tool implementation
 *
 * Spawns specialized subagents to handle complex, multi-step tasks autonomously.
 * Supports both built-in subagent types and custom subagents defined in .letta/agents/.
 */

import { getClient } from "../../agent/client";
import { getConversationId, getCurrentAgentId } from "../../agent/context";
import {
  clearSubagentConfigCache,
  discoverSubagents,
  getAllSubagentConfigs,
} from "../../agent/subagents";
import { spawnSubagent } from "../../agent/subagents/manager";
import { addToMessageQueue } from "../../cli/helpers/messageQueueBridge.js";
import {
  completeSubagent,
  generateSubagentId,
  getSnapshot as getSubagentSnapshot,
  getSubagentToolCount,
  registerSubagent,
} from "../../cli/helpers/subagentState.js";
import { formatTaskNotification } from "../../cli/helpers/taskNotifications.js";
import { runSubagentStopHooks } from "../../hooks";
import { getCurrentWorkingDirectory } from "../../runtime-context";
import {
  appendToOutputFile,
  assertBackgroundTaskCapacity,
  type BackgroundTask,
  backgroundTasks,
  createBackgroundOutputFile,
  getNextTaskId,
  scheduleBackgroundTaskCleanup,
  setBackgroundTaskOutput,
} from "./process_manager.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation";

interface TaskArgs {
  command?: "run" | "refresh";
  subagent_type?: string;
  prompt?: string;
  description?: string;
  model?: string;
  agent_id?: string; // Deploy an existing agent instead of creating new
  conversation_id?: string; // Resume from an existing conversation
  run_in_background?: boolean; // Run the task in background
  max_turns?: number; // Maximum number of agentic turns
  toolCallId?: string; // Injected by executeTool for linking subagent to parent tool call
  signal?: AbortSignal; // Injected by executeTool for interruption handling
  parentScope?: { agentId: string; conversationId: string }; // Injected by executeTool for notification routing
}

// Valid subagent_types when deploying an existing agent
const VALID_DEPLOY_TYPES = new Set(["explore", "general-purpose"]);
const BACKGROUND_STARTUP_POLL_MS = 50;

type TaskRunResult = {
  agentId: string;
  conversationId?: string;
  report: string;
  success: boolean;
  error?: string;
  totalTokens?: number;
};

export interface SpawnBackgroundSubagentTaskArgs {
  subagentType: string;
  prompt: string;
  description: string;
  model?: string;
  toolCallId?: string;
  existingAgentId?: string;
  existingConversationId?: string;
  maxTurns?: number;
  forkedContext?: boolean;
  /** Parent conversation scope for routing notifications in listener mode. */
  parentScope?: { agentId: string; conversationId: string };
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
   */
  onComplete?: (result: {
    success: boolean;
    error?: string;
    agentId?: string;
    conversationId?: string;
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
  result?: Pick<TaskRunResult, "agentId" | "conversationId">,
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
  result: TaskRunResult,
  header: string,
): void {
  if (result.success) {
    appendToOutputFile(
      outputFile,
      `${header}\n\n${result.report}\n\n[Task completed]\n`,
    );
    return;
  }

  appendToOutputFile(
    outputFile,
    `${header ? `${header}\n\n` : ""}[error] ${result.error || "Subagent execution failed"}\n\n[Task failed]\n`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveParentScope(parentScope?: {
  agentId: string;
  conversationId: string;
}): { agentId: string; conversationId: string } | undefined {
  if (parentScope?.agentId) {
    return {
      agentId: parentScope.agentId,
      conversationId: parentScope.conversationId || "default",
    };
  }

  try {
    return {
      agentId: getCurrentAgentId(),
      conversationId: getConversationId() ?? "default",
    };
  } catch {
    return undefined;
  }
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
    if (agent.agentURL) {
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

/**
 * Spawn a background subagent task and return task metadata immediately.
 * Notification/hook behavior is identical to Task's background path.
 */
export function spawnBackgroundSubagentTask(
  args: SpawnBackgroundSubagentTaskArgs,
): SpawnBackgroundSubagentTaskResult {
  assertBackgroundTaskCapacity();

  const {
    subagentType,
    prompt,
    description,
    model,
    toolCallId,
    existingAgentId,
    existingConversationId,
    maxTurns,
    forkedContext,
    parentScope,
    silentCompletion,
    emitCompletionNotification,
    completionSummary,
    onComplete,
    deps,
  } = args;
  const shouldEmitCompletionNotification =
    emitCompletionNotification ?? !silentCompletion;

  const resolvedParentScope = resolveParentScope(parentScope);

  const spawnSubagentFn = deps?.spawnSubagentImpl ?? spawnSubagent;
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
    subagentType,
    description,
    toolCallId,
    true,
    silentCompletion,
    resolvedParentScope,
  );

  const taskId = getNextTaskId();
  const outputFile = createBackgroundOutputFile(taskId);
  const abortController = new AbortController();

  const bgTask: BackgroundTask = {
    description,
    subagentType,
    subagentId,
    status: "running",
    output: [],
    startTime: new Date(),
    outputFile,
    abortController,
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
  spawnSubagentFn(
    subagentType,
    prompt,
    model,
    subagentId,
    abortController.signal,
    existingAgentId,
    existingConversationId,
    maxTurns,
    forkedContext,
    parentAgentIdForSpawn,
  )
    .then(async (result) => {
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
      writeTaskTranscriptResult(outputFile, result, header);
      if (result.success) {
        setBackgroundTaskOutput(bgTask, result.report || "");
      }
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
          { workingDirectory: userCwd, toolName: "Task" },
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
      appendToOutputFile(outputFile, `[error] ${errorMessage}\n`);
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
    });

  return { taskId, outputFile, subagentId };
}

/**
 * Task tool - Launch a specialized subagent to handle complex tasks
 */
export async function task(args: TaskArgs): Promise<string> {
  const { command = "run", model, toolCallId, signal } = args;

  // Handle refresh command - re-discover subagents from .letta/agents/ directories
  if (command === "refresh") {
    // Clear the cache to force re-discovery
    clearSubagentConfigCache();

    // Discover subagents from global and project directories
    const { subagents, errors } = await discoverSubagents();

    // Get all configs (builtins + discovered) to report accurate count
    const allConfigs = await getAllSubagentConfigs();
    const totalCount = Object.keys(allConfigs).length;
    const customCount = subagents.length;

    // Log any errors
    if (errors.length > 0) {
      for (const error of errors) {
        console.warn(
          `Subagent discovery error: ${error.path}: ${error.message}`,
        );
      }
    }

    const errorSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : "";
    return `Refreshed subagents list: found ${totalCount} total (${customCount} custom)${errorSuffix}`;
  }

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

  // Get all available subagent configs (built-in + custom)
  const allConfigs = await getAllSubagentConfigs();

  // Validate subagent type
  if (!(subagent_type in allConfigs)) {
    const available = Object.keys(allConfigs).join(", ");
    return `Error: Invalid subagent type "${subagent_type}". Available types: ${available}`;
  }

  // For existing agents, only allow explore or general-purpose
  if (isDeployingExisting && !VALID_DEPLOY_TYPES.has(subagent_type)) {
    return `Error: When deploying an existing agent, subagent_type must be "explore" (read-only) or "general-purpose" (read-write). Got: "${subagent_type}"`;
  }

  // If subagent config requires forked context, fork the parent conversation
  const config = allConfigs[subagent_type];
  if (!config) {
    return `Error: Invalid subagent type "${subagent_type}"`;
  }
  let effectiveAgentId = args.agent_id;
  let effectiveConversationId = args.conversation_id;

  if (config.fork) {
    if (args.agent_id || args.conversation_id) {
      return "Error: Subagent type with fork: true cannot be combined with agent_id or conversation_id";
    }
    try {
      const client = await getClient();
      const parentAgentId = getCurrentAgentId();
      const parentConvId = getConversationId() ?? "default";
      // Mark the forked conversation as hidden so it doesn't clutter the
      // parent agent's conversation list in the ADE. The subagent still
      // reads/writes this conversation normally — only archive status is
      // affected.
      const forkedConv = (await client.post(
        `/v1/conversations/${encodeURIComponent(parentConvId)}/fork`,
        {
          query: {
            ...(parentConvId === "default" ? { agent_id: parentAgentId } : {}),
            hidden: true,
          },
        },
      )) as { id: string };
      effectiveAgentId = parentAgentId;
      effectiveConversationId = forkedConv.id;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `Error: Failed to fork parent conversation: ${errorMessage}`;
    }
  }

  const prompt = inputPrompt;

  const isBackground = args.run_in_background ?? config.background;
  const resolvedParentScope = resolveParentScope(args.parentScope);

  // Handle background execution
  if (isBackground) {
    const { taskId, outputFile, subagentId } = spawnBackgroundSubagentTask({
      subagentType: subagent_type,
      prompt,
      description,
      model,
      toolCallId,
      existingAgentId: effectiveAgentId,
      existingConversationId: effectiveConversationId,
      maxTurns: args.max_turns,
      forkedContext: config.fork,
      parentScope: resolvedParentScope,
    });

    await waitForBackgroundSubagentLink(subagentId, null, signal);

    // Extract Letta agent ID from subagent state (available after link resolves)
    const linkedAgent = getSubagentSnapshot().agents.find(
      (a) => a.id === subagentId,
    );
    const agentId = linkedAgent?.agentId ?? null;
    const agentIdLine = agentId ? `\nAgent ID: ${agentId}` : "";

    return `Task running in background with task ID: ${taskId}${agentIdLine}\nOutput file: ${outputFile}\n\nYou will be notified automatically when this task completes — a <task-notification> message will be delivered with the result. No need to poll, sleep-wait, or check the output file. Just continue with your current work.`;
  }

  // Register subagent with state store for UI display (foreground path)
  const subagentId = generateSubagentId();
  registerSubagent(
    subagentId,
    subagent_type,
    description,
    toolCallId,
    false,
    false,
    resolvedParentScope,
  );

  // Foreground tasks now also write transcripts so users can inspect full output
  // even when inline content is truncated.
  const foregroundTaskId = getNextTaskId();
  const outputFile = createBackgroundOutputFile(foregroundTaskId);
  writeTaskTranscriptStart(outputFile, description, subagent_type);

  try {
    // See spawnBackgroundSubagentTask for rationale: capture parentAgentId
    // synchronously here to avoid the async-drift race inside spawnSubagent.
    const parentAgentIdForSpawn = resolvedParentScope?.agentId;
    const result = await spawnSubagent(
      subagent_type,
      prompt,
      model,
      subagentId,
      signal,
      effectiveAgentId,
      effectiveConversationId,
      args.max_turns,
      config.fork,
      parentAgentIdForSpawn,
    );

    // Mark subagent as completed in state store
    completeSubagent(subagentId, {
      success: result.success,
      error: result.error,
      totalTokens: result.totalTokens,
    });

    // Run SubagentStop hooks (fire-and-forget)
    runSubagentStopHooks(
      subagent_type,
      subagentId,
      result.success,
      result.error,
      result.agentId,
      result.conversationId,
    ).catch(() => {
      // Silently ignore hook errors
    });

    if (!result.success) {
      const errorMessage = result.error || "Subagent execution failed";
      const failedResult: TaskRunResult = {
        ...result,
        error: errorMessage,
      };
      const header = buildTaskResultHeader(
        subagent_type,
        subagentId,
        failedResult,
        "error",
      );
      writeTaskTranscriptResult(outputFile, failedResult, header);
      return `${header}\n\nError: ${errorMessage}\nOutput file: ${outputFile}`;
    }

    // Include stable subagent metadata so orchestrators can attribute results.
    // Keep the tool return type as a string for compatibility.
    const header = buildTaskResultHeader(
      subagent_type,
      subagentId,
      result,
      "success",
    );

    const fullOutput = `${header}\n\n${result.report}`;
    writeTaskTranscriptResult(outputFile, result, header);

    const userCwd = getCurrentWorkingDirectory();

    // Apply truncation to prevent excessive token usage (same pattern as Bash tool)
    const { content: truncatedOutput } = truncateByChars(
      fullOutput,
      LIMITS.TASK_OUTPUT_CHARS,
      "Task",
      { workingDirectory: userCwd, toolName: "Task" },
    );

    return `${truncatedOutput}\nOutput file: ${outputFile}`;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const header = buildTaskResultHeader(
      subagent_type,
      subagentId,
      {
        agentId: effectiveAgentId ?? "",
        conversationId: effectiveConversationId,
      },
      "error",
    );
    completeSubagent(subagentId, { success: false, error: errorMessage });

    // Run SubagentStop hooks for error case (fire-and-forget)
    runSubagentStopHooks(
      subagent_type,
      subagentId,
      false,
      errorMessage,
      effectiveAgentId,
      effectiveConversationId,
    ).catch(() => {
      // Silently ignore hook errors
    });

    appendToOutputFile(
      outputFile,
      `${header}\n\n[error] ${errorMessage}\n\n[Task failed]\n`,
    );
    return `${header}\n\nError: ${errorMessage}\nOutput file: ${outputFile}`;
  }
}
