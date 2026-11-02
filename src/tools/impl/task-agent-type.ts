/**
 * Agent tool launch selection: `agent_type` + `fork_context`.
 *
 * `agent_type` picks the runtime: `letta` (default), an external coding worker
 * (`claude-code`, `codex`, ...), or a named Letta subagent with its own prompt
 * and toolset (`recall`, `reflection`, `init`, user-defined subagents).
 * `fork_context` is orthogonal: it hands the parent conversation to the child.
 */

import type { SubagentConfig } from "@/agent/subagents";
import {
  EXTERNAL_CODING_AGENT_TYPES,
  type ExternalCodingAgentType,
  isExternalCodingAgentType,
} from "./external-coding-agent";

export const LETTA_AGENT_TYPE = "letta";
/** Internal config names that back `agent_type: "letta"`. */
export const DEFAULT_LETTA_SUBAGENT = "general-purpose";
export const FORKED_LETTA_SUBAGENT = "fork";

export type TaskAgentSelection =
  | {
      kind: "external";
      type: ExternalCodingAgentType;
      forkContext: boolean;
    }
  | {
      kind: "letta";
      /** Subagent config name to execute. */
      subagentType: string;
      forkContext: boolean;
    };

export interface TaskAgentSelectionArgs {
  agent_type?: unknown;
  fork_context?: unknown;
}

/**
 * Former type names that now have a different spelling. They fail with the
 * fix instead of silently launching something else.
 */
const RETIRED_AGENT_TYPES: Record<string, string> = {
  [FORKED_LETTA_SUBAGENT]: `agent_type "${FORKED_LETTA_SUBAGENT}" was replaced by fork_context: true; pass fork_context: true and omit agent_type (it defaults to "${LETTA_AGENT_TYPE}")`,
  [DEFAULT_LETTA_SUBAGENT]: `agent_type "${DEFAULT_LETTA_SUBAGENT}" is now the default "${LETTA_AGENT_TYPE}"; omit agent_type or pass agent_type: "${LETTA_AGENT_TYPE}"`,
};

/**
 * Resolve the launch selection from tool/App Server arguments.
 *
 * Returns an error string for malformed or retired input. Whether a named
 * subagent supports `fork_context` depends on its config, so callers check
 * that after loading it.
 */
export function resolveTaskAgentSelection(
  args: TaskAgentSelectionArgs,
): { selection: TaskAgentSelection } | { error: string } {
  // The schema rejects the removed field, but not every provider enforces
  // tool schemas; never let it fall through to the default agent silently.
  if ("subagent_type" in args) {
    return {
      error: `subagent_type was removed; use agent_type (default "${LETTA_AGENT_TYPE}"), and fork_context: true instead of "${FORKED_LETTA_SUBAGENT}"`,
    };
  }
  if (
    args.fork_context !== undefined &&
    typeof args.fork_context !== "boolean"
  ) {
    return { error: "fork_context must be a boolean" };
  }
  let type = LETTA_AGENT_TYPE;
  if (args.agent_type !== undefined) {
    if (typeof args.agent_type !== "string" || !args.agent_type.trim()) {
      return { error: "agent_type must be a non-empty string" };
    }
    type = args.agent_type.trim();
  }
  const retired = Object.hasOwn(RETIRED_AGENT_TYPES, type)
    ? RETIRED_AGENT_TYPES[type]
    : undefined;
  if (retired) return { error: retired };
  const forkContext = args.fork_context === true;

  if (isExternalCodingAgentType(type)) {
    return { selection: { kind: "external", type, forkContext } };
  }
  if (type === LETTA_AGENT_TYPE) {
    return {
      selection: {
        kind: "letta",
        subagentType: forkContext
          ? FORKED_LETTA_SUBAGENT
          : DEFAULT_LETTA_SUBAGENT,
        forkContext,
      },
    };
  }
  return { selection: { kind: "letta", subagentType: type, forkContext } };
}

/** Display name for a resolved selection, as callers see it in errors. */
export function describeTaskAgentType(selection: TaskAgentSelection): string {
  if (selection.kind === "external") return selection.type;
  return selection.subagentType === DEFAULT_LETTA_SUBAGENT ||
    selection.subagentType === FORKED_LETTA_SUBAGENT
    ? LETTA_AGENT_TYPE
    : selection.subagentType;
}

/** The agent_type values to suggest, given the loaded Letta config names. */
export function listAgentTypes(configNames: string[]): string {
  const hidden = new Set([
    DEFAULT_LETTA_SUBAGENT,
    FORKED_LETTA_SUBAGENT,
    "memory",
  ]);
  return [
    LETTA_AGENT_TYPE,
    ...EXTERNAL_CODING_AGENT_TYPES,
    ...configNames.filter((name) => !hidden.has(name)),
  ].join(", ");
}

/** Config for an App Server-prepared conversation (`agent_type: custom`). */
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
