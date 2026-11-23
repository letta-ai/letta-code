import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";
import { readSubagentDepth } from "@/utils/subagent-depth-env";
import type { SubagentConfig } from ".";

export const MAX_SUBAGENT_DEPTH = 2;

export function getCurrentSubagentDepth(): number {
  return readSubagentDepth(
    getRuntimeExecutionEnv(process.env, getRuntimeContext()?.executionSettings),
  );
}

export function canLaunchSubagentsAtDepth(depth: number): boolean {
  return depth < MAX_SUBAGENT_DEPTH;
}

export function resolveSubagentHarnessTools(
  type: string,
  config: Pick<SubagentConfig, "allowedTools" | "launchProfile">,
  childDepth = getCurrentSubagentDepth() + 1,
): string[] {
  if (config.launchProfile === "memory-subagent") return [];
  const fullCapability =
    type === "general-purpose" || config.allowedTools === "all";
  return fullCapability && canLaunchSubagentsAtDepth(childDepth)
    ? ["SendAgentMessage", "Agent", "ListSubagents"]
    : ["SendAgentMessage"];
}
