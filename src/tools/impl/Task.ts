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

interface TaskResult {
  agentId: string;
  type: string;
  description: string;
  report: string;
  success: boolean;
  error?: string;
}

/**
 * Task tool - Launch a specialized subagent to handle complex tasks
 */
export async function task(args: TaskArgs): Promise<TaskResult> {
  // Validate required parameters
  validateRequiredParams(args, ["subagent_type", "prompt", "description"]);

  const { subagent_type, prompt, description, model, resume } = args;

  // Get current agent ID from context
  const mainAgentId = getCurrentAgentId();
  if (!mainAgentId) {
    return {
      agentId: "",
      type: subagent_type,
      description,
      report: "",
      success: false,
      error:
        "No agent context available. Task tool can only be called from within an agent.",
    };
  }

  // Validate subagent type
  if (!isValidSubagentType(subagent_type)) {
    return {
      agentId: "",
      type: subagent_type,
      description,
      report: "",
      success: false,
      error: `Invalid subagent type: ${subagent_type}. Valid types are: Explore, Plan, general-purpose`,
    };
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

    return {
      agentId: result.agentId,
      type: subagent_type,
      description,
      report: result.report,
      success: result.success,
      error: result.error,
    };
  } catch (error) {
    return {
      agentId: "",
      type: subagent_type,
      description,
      report: "",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
