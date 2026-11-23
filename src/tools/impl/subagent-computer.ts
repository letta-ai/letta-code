import type { SubagentConfig } from "@/agent/subagents";
import { getBackend } from "@/backend";

export const DEFAULT_SUBAGENT_COMPUTER_ENV_VAR =
  "LETTA_DEFAULT_SUBAGENT_COMPUTER";

const LOCAL_COMPUTER_SELECTORS = new Set(["local", "self"]);

export type SubagentComputerSource = "explicit" | "default" | "none";

export interface ResolvedSubagentComputer {
  computer: string | undefined;
  source: SubagentComputerSource;
}

export function isLocalComputerSelector(value: string): boolean {
  return LOCAL_COMPUTER_SELECTORS.has(value.trim().toLowerCase());
}

export function acceptsDefaultComputer(input: {
  subagentType: string;
  config: Pick<SubagentConfig, "fork" | "launchProfile">;
}): boolean {
  return (
    input.subagentType !== "memory" &&
    input.subagentType !== "recall" &&
    input.config.launchProfile !== "memory-subagent"
  );
}

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

function backendSupportsEnvironmentRouting(): boolean {
  try {
    return getBackend().capabilities.environmentRouting;
  } catch {
    return false;
  }
}

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
