// Nested Agent policy. The root agent is depth 0 and each Agent launch adds
// one. Agent is attached below MAX_SUBAGENT_DEPTH, so a root's child may launch
// one more layer and that grandchild is a leaf. Every delegated subagent gets
// SendAgentMessage so it can reach its parent without shelling out to the CLI.

import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";
import { readSubagentDepth } from "@/utils/subagent-depth-env";
import type { SubagentConfig } from ".";

export const MAX_SUBAGENT_DEPTH = 2;

/** Depth of the agent whose turn is executing, including listener-hosted turns. */
export function getCurrentSubagentDepth(): number {
  return readSubagentDepth(
    getRuntimeExecutionEnv(process.env, getRuntimeContext()?.executionSettings),
  );
}

export function canLaunchSubagentsAtDepth(depth: number): boolean {
  return depth < MAX_SUBAGENT_DEPTH;
}

/**
 * Harness tools added to a child's explicit tool list. Memory-profile workers
 * (reflection, memory, init) are excluded: they maintain the parent's memory
 * in a confined process and must not message or launch agents. Agent is only
 * added to full-capability types, so a restricted type such as recall cannot
 * escape its tool list by launching a general-purpose child. Configs with
 * `tools: all` (fork) receive no list; the child's tool policy filters Agent.
 */
export function resolveSubagentHarnessTools(
  type: string,
  config: Pick<SubagentConfig, "allowedTools" | "launchProfile">,
  childDepth = getCurrentSubagentDepth() + 1,
): string[] {
  if (config.launchProfile === "memory-subagent") return [];
  const fullCapability =
    type === "general-purpose" || config.allowedTools === "all";
  return fullCapability && canLaunchSubagentsAtDepth(childDepth)
    ? ["SendAgentMessage", "Agent"]
    : ["SendAgentMessage"];
}
