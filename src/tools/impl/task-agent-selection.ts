/**
 * Agent tool launch selection: `harness` + `subagent_type` + `fork_context`.
 *
 * `harness` picks the runner: `letta` (default) or an external coding worker
 * (`claude-code`, `codex`, ...). `subagent_type` picks a specialized Letta
 * subagent with its own prompt and toolset (`recall`, user-defined subagents)
 * and only applies to `letta`. `fork_context` hands the parent conversation to
 * the child.
 */

import type { SubagentConfig } from "@/agent/subagents";
import {
  INTERNAL_SUBAGENT_TYPES,
  MODEL_HIDDEN_SUBAGENT_NAMES,
} from "@/agent/subagents/subagent-names";
import {
  EXTERNAL_CODING_AGENT_TYPES,
  type ExternalCodingAgentType,
  isExternalCodingAgentType,
} from "./external-coding-agent";

export const LETTA_HARNESS = "letta";
export const TASK_HARNESSES = [
  LETTA_HARNESS,
  ...EXTERNAL_CODING_AGENT_TYPES,
] as const;
/** Internal config names that back the default Letta agent. */
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
      /** The caller named a specialized subagent (not the default agent). */
      specialized: boolean;
      forkContext: boolean;
    };

export interface TaskAgentSelectionArgs {
  harness?: unknown;
  subagent_type?: unknown;
  fork_context?: unknown;
}

/** Former `subagent_type` values that now have a different spelling. */
const RETIRED_SUBAGENT_TYPES: Record<string, string> = {
  [FORKED_LETTA_SUBAGENT]: `subagent_type "${FORKED_LETTA_SUBAGENT}" was removed; use fork_context: true and omit subagent_type`,
  [DEFAULT_LETTA_SUBAGENT]: `subagent_type "${DEFAULT_LETTA_SUBAGENT}" was removed; omit subagent_type for the default agent`,
};

function nonEmptyString(
  value: unknown,
  name: string,
): { value?: string } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.trim())
    return { error: `${name} must be a non-empty string` };
  return { value: value.trim() };
}

/**
 * Resolve the launch selection from Agent tool arguments.
 *
 * Returns an error string for malformed or retired input. Whether a named
 * subagent supports `fork_context` depends on its config, so callers check
 * that after loading it.
 */
export function resolveTaskAgentSelection(
  args: TaskAgentSelectionArgs,
): { selection: TaskAgentSelection } | { error: string } {
  // The schema rejects the old field, but not every provider enforces tool
  // schemas; never let it fall through to the default agent silently.
  if ("agent_type" in args) {
    return {
      error: `agent_type was renamed to harness; pass harness ("${TASK_HARNESSES.join('", "')}") and, for a specialized Letta subagent, subagent_type`,
    };
  }
  if (
    args.fork_context !== undefined &&
    typeof args.fork_context !== "boolean"
  ) {
    return { error: "fork_context must be a boolean" };
  }
  const harnessArg = nonEmptyString(args.harness, "harness");
  if ("error" in harnessArg) return harnessArg;
  const subagentArg = nonEmptyString(args.subagent_type, "subagent_type");
  if ("error" in subagentArg) return subagentArg;
  const harness = harnessArg.value ?? LETTA_HARNESS;
  const subagentType = subagentArg.value;
  const forkContext = args.fork_context === true;

  if (harness !== LETTA_HARNESS && !isExternalCodingAgentType(harness)) {
    return {
      error: `Invalid harness "${harness}". Use one of: ${TASK_HARNESSES.join(", ")}`,
    };
  }

  if (subagentType !== undefined) {
    if (isExternalCodingAgentType(subagentType)) {
      return {
        error: `"${subagentType}" is a harness, not a subagent_type; pass harness: "${subagentType}" and omit subagent_type`,
      };
    }
    if (subagentType === LETTA_HARNESS) {
      return {
        error: `"${LETTA_HARNESS}" is a harness, not a subagent_type; omit subagent_type for the default agent`,
      };
    }
    const retired = Object.hasOwn(RETIRED_SUBAGENT_TYPES, subagentType)
      ? RETIRED_SUBAGENT_TYPES[subagentType]
      : undefined;
    if (retired) return { error: retired };
    if (INTERNAL_SUBAGENT_TYPES.has(subagentType)) {
      return {
        error: `"${subagentType}" is an internal subagent type launched by the harness; it cannot be selected with subagent_type`,
      };
    }
    if (harness !== LETTA_HARNESS) {
      return {
        error: `subagent_type only applies to harness "${LETTA_HARNESS}"; omit subagent_type when harness is "${harness}"`,
      };
    }
    return {
      selection: {
        kind: "letta",
        subagentType,
        specialized: true,
        forkContext,
      },
    };
  }

  if (isExternalCodingAgentType(harness)) {
    return { selection: { kind: "external", type: harness, forkContext } };
  }
  return {
    selection: {
      kind: "letta",
      subagentType: forkContext
        ? FORKED_LETTA_SUBAGENT
        : DEFAULT_LETTA_SUBAGENT,
      specialized: false,
      forkContext,
    },
  };
}

/** Display name for a resolved selection, as callers see it in errors. */
export function describeTaskAgentSelection(
  selection: TaskAgentSelection,
): string {
  if (selection.kind === "external") return selection.type;
  return selection.specialized
    ? `subagent_type "${selection.subagentType}"`
    : `harness "${LETTA_HARNESS}"`;
}

/** Whether a loaded Letta config is a model-selectable `subagent_type`. */
export function isSelectableSubagentType(name: string): boolean {
  return !MODEL_HIDDEN_SUBAGENT_NAMES.has(name);
}

/** The subagent_type values to suggest, given the loaded Letta config names. */
export function listSubagentTypes(configNames: string[]): string {
  const names = configNames.filter(isSelectableSubagentType);
  return names.length > 0 ? names.join(", ") : "(none)";
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
