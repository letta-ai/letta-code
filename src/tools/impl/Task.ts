/**
 * Task tool implementation
 *
 * Spawns specialized subagents to handle complex, multi-step tasks autonomously.
 * Supports both built-in subagent types and custom subagents defined in .letta/agents/.
 */

import { getCurrentAgentId } from "../../agent/context";
import { getAllSubagentConfigs } from "../../agent/subagents";
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
 * Format args for display (truncate prompt)
 */
function formatTaskArgs(args: TaskArgs): string {
  const parts: string[] = [];
  parts.push(`subagent_type="${args.subagent_type}"`);
  parts.push(`description="${args.description}"`);
  // Truncate prompt for display
  const promptPreview =
    args.prompt.length > 20 ? args.prompt.slice(0, 17) + "..." : args.prompt;
  parts.push(`prompt="${promptPreview}"`);
  if (args.model) parts.push(`model="${args.model}"`);
  return parts.join(", ");
}

/**
 * Task tool - Launch a specialized subagent to handle complex tasks
 */
export async function task(args: TaskArgs): Promise<string> {
  // Validate required parameters
  validateRequiredParams(args, ["subagent_type", "prompt", "description"]);

  const { subagent_type, prompt, description, model, resume } = args;

  // Print Task header FIRST so subagent output appears below it
  console.log(`● Task(${formatTaskArgs(args)})`);

  // Get current agent ID from context
  const mainAgentId = getCurrentAgentId();
  if (!mainAgentId) {
    return "Error: No agent context available. Task tool can only be called from within an agent.";
  }

  // Get all available subagent configs (built-in + custom)
  const allConfigs = await getAllSubagentConfigs();

  // Validate subagent type
  if (!(subagent_type in allConfigs)) {
    const available = Object.keys(allConfigs).join(", ");
    return `Error: Invalid subagent type "${subagent_type}". Available types: ${available}`;
  }

  try {
    let result;

    // Handle resume vs new subagent
    if (resume) {
      result = await resumeSubagent(mainAgentId, resume, prompt);
    } else {
      result = await spawnSubagent(
        mainAgentId,
        subagent_type,
        prompt,
        description,
        model,
      );
    }

    if (!result.success) {
      return `Error: ${result.error || "Subagent execution failed"}`;
    }

    return result.report;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
