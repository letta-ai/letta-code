/**
 * Task tool implementation
 *
 * Spawns specialized subagents to handle complex, multi-step tasks autonomously.
 * Supports both built-in subagent types and custom subagents defined in .letta/agents/.
 */

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
  registerSubagent,
} from "../../cli/helpers/subagentState.js";
import { formatTaskNotification } from "../../cli/helpers/taskNotifications.js";
import { runSubagentStopHooks } from "../../hooks";
import {
  appendToOutputFile,
  type BackgroundTask,
  backgroundTasks,
  createBackgroundOutputFile,
  getNextTaskId,
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

function buildTaskResultHeader(
  subagentType: string,
  result: Pick<TaskRunResult, "agentId" | "conversationId">,
): string {
  return [
    `subagent_type=${subagentType}`,
    result.agentId ? `agent_id=${result.agentId}` : undefined,
    result.conversationId
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
    `[error] ${result.error || "Subagent execution failed"}\n\n[Task failed]\n`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Spawn a background subagent task and return task metadata immediately.
 * Notification/hook behavior is identical to Task's background path.
 */
export function spawnBackgroundSubagentTask(
  args: SpawnBackgroundSubagentTaskArgs,
): SpawnBackgroundSubagentTaskResult {
  const {
    subagentType,
    prompt,
    description,
    model,
    toolCallId,
    existingAgentId,
    existingConversationId,
    maxTurns,
    deps,
  } = args;

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
  registerSubagentFn(subagentId, subagentType, description, toolCallId, true);

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

  spawnSubagentFn(
    subagentType,
    prompt,
    model,
    subagentId,
    abortController.signal,
    existingAgentId,
    existingConversationId,
    maxTurns,
  )
    .then((result) => {
      bgTask.status = result.success ? "completed" : "failed";
      if (result.error) {
        bgTask.error = result.error;
      }

      const header = buildTaskResultHeader(subagentType, result);
      writeTaskTranscriptResult(outputFile, result, header);
      if (result.success) {
        bgTask.output.push(result.report || "");
      }

      completeSubagentFn(subagentId, {
        success: result.success,
        error: result.error,
        totalTokens: result.totalTokens,
      });

      const subagentSnapshot = getSubagentSnapshotFn();
      const toolUses = subagentSnapshot.agents.find(
        (agent) => agent.id === subagentId,
      )?.toolCalls.length;
      const durationMs = Math.max(0, Date.now() - bgTask.startTime.getTime());

      const fullResult = result.success
        ? `${header}\n\n${result.report || ""}`
        : result.error || "Subagent execution failed";
      const userCwd = process.env.USER_CWD || process.cwd();
      const { content: truncatedResult } = truncateByChars(
        fullResult,
        LIMITS.TASK_OUTPUT_CHARS,
        "Task",
        { workingDirectory: userCwd, toolName: "Task" },
      );

      const notificationXml = formatTaskNotificationFn({
        taskId,
        status: result.success ? "completed" : "failed",
        summary: `Agent "${description}" ${result.success ? "completed" : "failed"}`,
        result: truncatedResult,
        outputFile,
        usage: {
          totalTokens: result.totalTokens,
          toolUses,
          durationMs,
        },
      });
      addToMessageQueueFn({ kind: "task_notification", text: notificationXml });

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
    .catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      bgTask.status = "failed";
      bgTask.error = errorMessage;
      appendToOutputFile(outputFile, `[error] ${errorMessage}\n`);
      completeSubagentFn(subagentId, { success: false, error: errorMessage });

      const subagentSnapshot = getSubagentSnapshotFn();
      const toolUses = subagentSnapshot.agents.find(
        (agent) => agent.id === subagentId,
      )?.toolCalls.length;
      const durationMs = Math.max(0, Date.now() - bgTask.startTime.getTime());
      const notificationXml = formatTaskNotificationFn({
        taskId,
        status: "failed",
        summary: `Agent "${description}" failed`,
        result: errorMessage,
        outputFile,
        usage: {
          toolUses,
          durationMs,
        },
      });
      addToMessageQueueFn({ kind: "task_notification", text: notificationXml });

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
  const prompt = args.prompt as string;
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

  const isBackground = args.run_in_background ?? false;

  // Handle background execution
  if (isBackground) {
    const { taskId, outputFile, subagentId } = spawnBackgroundSubagentTask({
      subagentType: subagent_type,
      prompt,
      description,
      model,
      toolCallId,
      existingAgentId: args.agent_id,
      existingConversationId: args.conversation_id,
      maxTurns: args.max_turns,
    });

    await waitForBackgroundSubagentLink(subagentId, null, signal);

    return `Task running in background with ID: ${taskId}\nOutput file: ${outputFile}`;
  }

  // Register subagent with state store for UI display (foreground path)
  const subagentId = generateSubagentId();
  registerSubagent(subagentId, subagent_type, description, toolCallId, false);

  // Foreground tasks now also write transcripts so users can inspect full output
  // even when inline content is truncated.
  const foregroundTaskId = getNextTaskId();
  const outputFile = createBackgroundOutputFile(foregroundTaskId);
  writeTaskTranscriptStart(outputFile, description, subagent_type);

  try {
    const result = await spawnSubagent(
      subagent_type,
      prompt,
      model,
      subagentId,
      signal,
      args.agent_id,
      args.conversation_id,
      args.max_turns,
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
      writeTaskTranscriptResult(outputFile, failedResult, "");
      return `Error: ${errorMessage}\nOutput file: ${outputFile}`;
    }

    // Include stable subagent metadata so orchestrators can attribute results.
    // Keep the tool return type as a string for compatibility.
    const header = buildTaskResultHeader(subagent_type, result);

    const fullOutput = `${header}\n\n${result.report}`;
    writeTaskTranscriptResult(outputFile, result, header);

    const userCwd = process.env.USER_CWD || process.cwd();

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
    completeSubagent(subagentId, { success: false, error: errorMessage });

    // Run SubagentStop hooks for error case (fire-and-forget)
    runSubagentStopHooks(
      subagent_type,
      subagentId,
      false,
      errorMessage,
      args.agent_id,
      args.conversation_id,
    ).catch(() => {
      // Silently ignore hook errors
    });

    appendToOutputFile(
      outputFile,
      `[error] ${errorMessage}\n\n[Task failed]\n`,
    );
    return `Error: ${errorMessage}\nOutput file: ${outputFile}`;
  }
}
