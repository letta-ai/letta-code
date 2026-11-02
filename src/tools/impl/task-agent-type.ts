/**
 * Agent tool launch selection: `agent_type` + `fork_context`, plus the
 * deprecated `subagent_type` alias.
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
  subagent_type?: unknown;
  fork_context?: unknown;
}

interface NormalizedType {
  type: string;
  forkContext: boolean;
}

/** Map a raw type name (new or legacy spelling) onto agent_type semantics. */
function normalizeType(raw: string): NormalizedType {
  const type = raw.trim();
  if (type === DEFAULT_LETTA_SUBAGENT) {
    return { type: LETTA_AGENT_TYPE, forkContext: false };
  }
  if (type === FORKED_LETTA_SUBAGENT) {
    return { type: LETTA_AGENT_TYPE, forkContext: true };
  }
  return { type, forkContext: false };
}

function readType(
  value: unknown,
  field: string,
): NormalizedType | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    return `${field} must be a non-empty string`;
  }
  return normalizeType(value);
}

/**
 * Resolve the launch selection from tool/App Server arguments.
 *
 * Returns an error string for contradictory or malformed input. Whether a
 * named subagent supports `fork_context` depends on its config, so callers
 * check that after loading it.
 */
export function resolveTaskAgentSelection(
  args: TaskAgentSelectionArgs,
): { selection: TaskAgentSelection } | { error: string } {
  if (
    args.fork_context !== undefined &&
    typeof args.fork_context !== "boolean"
  ) {
    return { error: "fork_context must be a boolean" };
  }
  const fromAgentType = readType(args.agent_type, "agent_type");
  if (typeof fromAgentType === "string") return { error: fromAgentType };
  const fromLegacy = readType(args.subagent_type, "subagent_type");
  if (typeof fromLegacy === "string") return { error: fromLegacy };

  if (
    fromAgentType &&
    fromLegacy &&
    (fromAgentType.type !== fromLegacy.type ||
      fromAgentType.forkContext !== fromLegacy.forkContext)
  ) {
    return {
      error:
        "Pass agent_type only; subagent_type is a deprecated alias and disagrees with it",
    };
  }

  const normalized = fromAgentType ??
    fromLegacy ?? { type: LETTA_AGENT_TYPE, forkContext: false };
  if (normalized.forkContext && args.fork_context === false) {
    return {
      error: `subagent_type "${FORKED_LETTA_SUBAGENT}" always forks context; omit fork_context: false`,
    };
  }
  const forkContext = normalized.forkContext || args.fork_context === true;

  if (isExternalCodingAgentType(normalized.type)) {
    return {
      selection: { kind: "external", type: normalized.type, forkContext },
    };
  }
  if (normalized.type === LETTA_AGENT_TYPE) {
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
  return {
    selection: { kind: "letta", subagentType: normalized.type, forkContext },
  };
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
