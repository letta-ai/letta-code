import type { SubagentConfig } from "@/agent/subagents";
import { MODEL_HIDDEN_SUBAGENT_NAMES } from "@/agent/subagents/subagent-names";
import type { SubagentLaunchArgs } from "@/types/subagent-protocol";
import {
  EXTERNAL_CODING_AGENT_TYPES,
  type ExternalCodingAgentType,
  isExternalCodingAgentType,
} from "./external-coding-agent-types";

export const TASK_HARNESSES = [
  "letta",
  ...EXTERNAL_CODING_AGENT_TYPES,
] as const;

/** A named preset owns launch settings; retain the assignment and harness metadata. */
export function applySubagentPreset<T extends Partial<SubagentLaunchArgs>>(
  args: T,
): T {
  if (args.subagent_type === undefined) return args;
  return {
    ...args,
    harness: undefined,
    fork_context: undefined,
    model: undefined,
    computer: undefined,
    agent_id: undefined,
    conversation_id: undefined,
    mcp: undefined,
  };
}

type TaskAgentSelection =
  | { kind: "external"; type: ExternalCodingAgentType }
  | { kind: "letta"; subagentType: string };

/** Resolve a preset first, otherwise the explicitly selected runner and context. */
export function resolveTaskAgentSelection(args: {
  harness?: unknown;
  subagent_type?: unknown;
  fork_context?: unknown;
}): { selection: TaskAgentSelection } | { error: string } {
  if (args.subagent_type !== undefined) {
    if (typeof args.subagent_type !== "string" || !args.subagent_type.trim())
      return { error: "subagent_type must be a non-empty string" };
    const name = args.subagent_type.trim();
    if (
      MODEL_HIDDEN_SUBAGENT_NAMES.has(name) ||
      TASK_HARNESSES.some((h) => h === name)
    ) {
      return {
        error: `"${name}" is not a selectable subagent_type. Omit subagent_type to use harness and fork_context, or choose a preset from Available Agents.`,
      };
    }
    return { selection: { kind: "letta", subagentType: name } };
  }
  if (args.fork_context !== undefined && typeof args.fork_context !== "boolean")
    return { error: "fork_context must be a boolean" };
  const harness = args.harness === undefined ? "letta" : args.harness;
  if (typeof harness !== "string" || !harness.trim())
    return { error: "harness must be a non-empty string" };
  const name = harness.trim();
  if (isExternalCodingAgentType(name))
    return { selection: { kind: "external", type: name } };
  if (name !== "letta")
    return {
      error: `Invalid harness "${name}". Use one of: ${TASK_HARNESSES.join(", ")}`,
    };
  return {
    selection: {
      kind: "letta",
      subagentType: args.fork_context ? "fork" : "general-purpose",
    },
  };
}

/** The subagent_type values to suggest, given the loaded Letta config names. */
export function listSubagentTypes(configNames: string[]): string {
  return (
    configNames
      .filter((name) => !MODEL_HIDDEN_SUBAGENT_NAMES.has(name))
      .join(", ") || "(none)"
  );
}

/** Config for an App Server-prepared conversation (`subagent_type: custom`). */
export function preparedConversationConfig(): SubagentConfig {
  return {
    name: "custom",
    description: "Prepared conversation",
    systemPrompt: "",
    allowedTools: "all",
    recommendedModel: "inherit",
    skills: [],
    fork: false,
    launchProfile: "default",
  };
}
