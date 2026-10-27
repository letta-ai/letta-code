import type { SubagentConfig } from "@/agent/subagents";
import { getBackend } from "@/backend";

/**
 * Supplies the `computer` an Agent launch gets when the caller omits one, so a
 * host can push implementation subagents off its own machine by default.
 * Harness conversations that run on a small shared sandbox set this to `cloud`
 * so a subagent's clone/install work lands on a fresh per-conversation sandbox
 * instead of filling the host's disk. Unset means no behavior change.
 */
export const DEFAULT_SUBAGENT_COMPUTER_ENV_VAR =
  "LETTA_DEFAULT_SUBAGENT_COMPUTER";

/**
 * Selectors that pin a subagent to the machine handling the launch. They give
 * a caller a way to opt out of `LETTA_DEFAULT_SUBAGENT_COMPUTER` for one launch
 * without having to know which machine it is running on.
 */
const LOCAL_COMPUTER_SELECTORS = new Set(["local", "self"]);

/** Where the resolved selector came from; callers treat the two differently. */
export type SubagentComputerSource = "explicit" | "default" | "none";

export interface ResolvedSubagentComputer {
  /** Selector to route with, or undefined to run on the current machine. */
  computer: string | undefined;
  source: SubagentComputerSource;
}

export function isLocalComputerSelector(value: string): boolean {
  return LOCAL_COMPUTER_SELECTORS.has(value.trim().toLowerCase());
}

/**
 * Whether a subagent type may pick up the ambient default.
 *
 * Memory-profile subagents (memory, reflection, init) use the parent's memory
 * tree as their working filesystem, and forks (fork, recall) inherit the
 * parent's transcript, which describes the parent's working directory. Moving
 * either to a fresh sandbox silently detaches it from the files its context
 * refers to. Both still accept an explicit `computer`, where the caller has
 * chosen the machine knowing that.
 *
 * `memory` is excluded by name as well as by profile: the tool docs promise it
 * runs on the current machine, and an ambient default must not turn that
 * promise into a launch failure if a config omits the profile.
 */
export function acceptsDefaultComputer(input: {
  subagentType: string;
  config: Pick<SubagentConfig, "fork" | "launchProfile">;
}): boolean {
  return (
    input.subagentType !== "memory" &&
    !input.config.fork &&
    input.config.launchProfile !== "memory-subagent"
  );
}

/**
 * Resolve the computer a subagent launch should route to.
 *
 * An explicit `computer` always wins, including the local selectors that force
 * the current machine. The env default only fills an omitted value, and only
 * for types that accept it.
 */
export function resolveSubagentComputer(input: {
  requested: unknown;
  subagentType: string;
  config: Pick<SubagentConfig, "fork" | "launchProfile">;
  env?: NodeJS.ProcessEnv;
}): ResolvedSubagentComputer {
  const requested =
    typeof input.requested === "string" ? input.requested.trim() : "";
  if (requested) {
    return isLocalComputerSelector(requested)
      ? { computer: undefined, source: "explicit" }
      : { computer: requested, source: "explicit" };
  }

  if (
    !acceptsDefaultComputer({
      subagentType: input.subagentType,
      config: input.config,
    })
  ) {
    return { computer: undefined, source: "none" };
  }

  const env = input.env ?? process.env;
  const fallback = (env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR] ?? "").trim();
  if (!fallback || isLocalComputerSelector(fallback)) {
    return { computer: undefined, source: "none" };
  }
  return { computer: fallback, source: "default" };
}

const MEMORY_IS_LOCAL_ERROR =
  "Memory workers must run on the current machine; omit computer.";
const NO_ROUTING_ERROR =
  "The computer option requires a Letta Cloud backend. This backend has no connected computers; omit the computer field to run the subagent on the current machine.";

/** Routing only exists on Letta Cloud; any other backend resolves to false. */
function backendSupportsEnvironmentRouting(): boolean {
  try {
    return getBackend().capabilities.environmentRouting;
  } catch {
    return false;
  }
}

/**
 * Resolve the computer for a launch, applying the rules that need the backend.
 *
 * Returns the selector to route with, or an `error` the caller surfaces as a
 * failed launch. A backend that cannot route rejects an explicit selector —
 * the caller chose that machine — but silently drops the env default, so one
 * misconfigured host does not fail every launch on it.
 */
export function resolveLaunchComputer(input: {
  requested: unknown;
  subagentType: string;
  config: Pick<SubagentConfig, "fork" | "launchProfile">;
  hasEnvironmentRouting?: () => boolean;
  env?: NodeJS.ProcessEnv;
}): { computer?: string; error?: string } {
  const resolved = resolveSubagentComputer(input);
  if (!resolved.computer) return {};
  if (input.subagentType === "memory") return { error: MEMORY_IS_LOCAL_ERROR };

  const hasRouting =
    input.hasEnvironmentRouting ?? backendSupportsEnvironmentRouting;
  if (hasRouting()) return { computer: resolved.computer };
  return resolved.source === "explicit" ? { error: NO_ROUTING_ERROR } : {};
}
