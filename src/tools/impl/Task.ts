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
import {
  completeSubagent,
  generateSubagentId,
  registerSubagent,
} from "../../cli/helpers/subagentState.js";
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
  toolCallId?: string; // Injected by executeTool for linking subagent to parent tool call
  signal?: AbortSignal; // Injected by executeTool for interruption handling
}

// Valid subagent_types when deploying an existing agent
const VALID_DEPLOY_TYPES = new Set(["explore", "general-purpose"]);

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

  // Register subagent with state store for UI display
  const subagentId = generateSubagentId();
  registerSubagent(subagentId, subagent_type, description, toolCallId);

  try {
    const result = await spawnSubagent(
      subagent_type,
      prompt,
      model,
      subagentId,
      signal,
      args.agent_id,
      args.conversation_id,
    );

    // Mark subagent as completed in state store
    completeSubagent(subagentId, {
      success: result.success,
      error: result.error,
      totalTokens: result.totalTokens,
    });

    if (!result.success) {
      return `Error: ${result.error || "Subagent execution failed"}`;
    }

    // Include stable subagent metadata so orchestrators can attribute results.
    // Keep the tool return type as a string for compatibility.
    const header = [
      `subagent_type=${subagent_type}`,
      result.agentId ? `agent_id=${result.agentId}` : undefined,
      result.conversationId
        ? `conversation_id=${result.conversationId}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    const fullOutput = `${header}\n\n${result.report}`;
    const userCwd = process.env.USER_CWD || process.cwd();

    // Apply truncation to prevent excessive token usage (same pattern as Bash tool)
    const { content: truncatedOutput } = truncateByChars(
      fullOutput,
      LIMITS.TASK_OUTPUT_CHARS,
      "Task",
      { workingDirectory: userCwd, toolName: "Task" },
    );

    return truncatedOutput;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    completeSubagent(subagentId, { success: false, error: errorMessage });
    return `Error: ${errorMessage}`;
  }
}
