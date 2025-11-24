/**
 * Task tool implementation
 *
 * Spawns specialized subagents to handle complex, multi-step tasks autonomously.
 */

import { getCurrentAgentId } from "../../agent/context";
import {
  type SubagentType,
  isValidSubagentType,
} from "../../agent/subagents";
import { resumeSubagent, spawnSubagent } from "../../agent/subagent-manager";
import { validateRequiredParams } from "./validation";

interface TaskArgs {
  subagent_type: string;
  prompt: string;
  description: string;
  model?: string;
  resume?: string;
}

/**
 * Task tool - Launch a specialized subagent to handle complex tasks
 * Returns the subagent's report (details are displayed live during execution)
 */
export async function task(args: TaskArgs): Promise<string> {
  // Validate required parameters
  validateRequiredParams(args, ["subagent_type", "prompt", "description"]);

  const { subagent_type, prompt, description, model, resume } = args;

  // Get current agent ID from context
  const mainAgentId = getCurrentAgentId();
  if (!mainAgentId) {
    return "Error: No agent context available. Task tool can only be called from within an agent.";
  }

  // Validate subagent type
  if (!isValidSubagentType(subagent_type)) {
    return `Error: Invalid subagent type: ${subagent_type}. Valid types are: Explore, Plan, general-purpose`;
  }

  try {
    let result;

    // Handle resume vs new subagent
    if (resume) {
      result = await resumeSubagent(mainAgentId, resume, prompt);
    } else {
      result = await spawnSubagent(
        mainAgentId,
        subagent_type as SubagentType,
        prompt,
        description,
        model,
      );
    }

    if (!result.success) {
      return `Error: ${result.error || "Subagent execution failed"}`;
    }

    // Return report for the main agent to use
    return result.report;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
