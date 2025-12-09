/**
 * Task tool implementation
 *
 * Spawns specialized subagents to handle complex, multi-step tasks autonomously.
 * Supports both built-in subagent types and custom subagents defined in .letta/agents/.
 */

import { getAllSubagentConfigs } from "../../agent/subagents";
import { spawnSubagent } from "../../agent/subagents/manager";
import { validateRequiredParams } from "./validation";

interface TaskArgs {
  subagent_type: string;
  prompt: string;
  description: string;
  model?: string;
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
    args.prompt.length > 20 ? `${args.prompt.slice(0, 17)}...` : args.prompt;
  parts.push(`prompt="${promptPreview}"`);
  if (args.model) parts.push(`model="${args.model}"`);
  return parts.join(", ");
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

  const { subagent_type, prompt, description, model } = args;

  // Print Task header FIRST so subagent output appears below it
  console.log(`\n● Task(${formatTaskArgs(args)})\n`);

  // Get all available subagent configs (built-in + custom)
  const allConfigs = await getAllSubagentConfigs();

  // Validate subagent type
  if (!(subagent_type in allConfigs)) {
    const available = Object.keys(allConfigs).join(", ");
    return `Error: Invalid subagent type "${subagent_type}". Available types: ${available}`;
  }

  try {
    const result = await spawnSubagent(
      subagent_type,
      prompt,
      description,
      model,
    );

    if (!result.success) {
      return `Error: ${result.error || "Subagent execution failed"}`;
    }

    return result.report;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
