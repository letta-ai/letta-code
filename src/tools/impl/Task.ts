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

  const { subagent_type, prompt, description, model, toolCallId } = args;

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
      description,
      model,
      subagentId,
    );

    // Mark subagent as completed in state store
    completeSubagent(subagentId, {
      success: result.success,
      error: result.error,
    });

    if (!result.success) {
      return `Error: ${result.error || "Subagent execution failed"}`;
    }

    return result.report;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    completeSubagent(subagentId, { success: false, error: errorMessage });
    return `Error: ${errorMessage}`;
  }
}
