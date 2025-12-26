/**
 * Task tool implementation
 *
 * Spawns specialized subagents to handle complex, multi-step tasks autonomously.
 * Supports both built-in subagent types and custom subagents defined in .letta/agents/.
 */

import { getAllSubagentConfigs } from "../../agent/subagents";
import { spawnSubagent } from "../../agent/subagents/manager";
import {
  completeSubagent,
  generateSubagentId,
  registerSubagent,
} from "../../cli/helpers/subagentState.js";
import { validateRequiredParams } from "./validation";

interface TaskArgs {
  subagent_type: string;
  prompt: string;
  description: string;
  model?: string;
  toolCallId?: string; // Injected by executeTool for linking subagent to parent tool call
  signal?: AbortSignal; // Injected by executeTool for interruption handling
}

/**
 * Task tool - Launch a specialized subagent to handle complex tasks
 */
export async function task(args: TaskArgs): Promise<string> {
  // Validate required parameters
  validateRequiredParams(
    args,
    ["subagent_type", "prompt", "description"],
    "Task",
  );

  const { subagent_type, prompt, description, model, toolCallId, signal } =
    args;

  // Get all available subagent configs (built-in + custom)
  const allConfigs = await getAllSubagentConfigs();

  // Validate subagent type
  if (!(subagent_type in allConfigs)) {
    const available = Object.keys(allConfigs).join(", ");
    return `Error: Invalid subagent type "${subagent_type}". Available types: ${available}`;
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
    ]
      .filter(Boolean)
      .join(" ");

    return `${header}\n\n${result.report}`;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    completeSubagent(subagentId, { success: false, error: errorMessage });
    return `Error: ${errorMessage}`;
  }
}
