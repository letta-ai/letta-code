import { homedir } from "node:os";
import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import { canonicalToolName, isShellToolName } from "./canonical";
import { cliPermissions } from "./cli-permissions-instance";
import { expandPathArgs } from "./file-path-args";
import { deriveAgentId, resolveMemoryTargetPath } from "./memory-paths";
import {
  canonicalizeRoot,
  getCrossBackendAgentsTreeRoots,
} from "./sandbox-policy";

export interface CrossAgentGuardOptions {
  env?: NodeJS.ProcessEnv;
  currentAgentId?: string | null;
  disableMemoryGuard?: boolean;
}

function isSubagentProcess(env: NodeJS.ProcessEnv): boolean {
  return env.LETTA_CODE_AGENT_ROLE === "subagent";
}

function deriveParentAgentId(env: NodeJS.ProcessEnv): string | null {
  if (!isSubagentProcess(env)) return null;
  const parent = env.LETTA_PARENT_AGENT_ID?.trim();
  return parent || null;
}

export function isMemoryGuardDisabled(
  options: CrossAgentGuardOptions = {},
): boolean {
  const env =
    options.env ??
    getRuntimeExecutionEnv(process.env, getRuntimeContext()?.executionSettings);
  if (isSubagentProcess(env)) return false;
  return options.disableMemoryGuard ?? cliPermissions.isMemoryGuardDisabled();
}

export function resolveAllowedAgents(
  options: CrossAgentGuardOptions = {},
): Set<string> {
  const env =
    options.env ??
    getRuntimeExecutionEnv(process.env, getRuntimeContext()?.executionSettings);

  const self = deriveAgentId(env, options.currentAgentId);
  const parent = deriveParentAgentId(env);

  const ids = new Set<string>();
  if (self) ids.add(self);
  if (parent) ids.add(parent);

  return ids;
}

type ToolArgs = Record<string, unknown>;

export interface CrossAgentTargets {
  agentIds: Set<string>;
  anyAgentScoped: boolean;
}

const UNRESOLVED_AGENT_ID = "<unresolved>";

function normalizePathForCompare(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.length === 0 ? "/" : normalized;
}

export type AgentsTreeClassification =
  | { kind: "outside" }
  | { kind: "agents-root" }
  | { kind: "ancestor" }
  | { kind: "agent"; id: string };

function getCrossAgentTreeRoots(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  return getCrossBackendAgentsTreeRoots({ homeDir, env }).map(
    normalizePathForCompare,
  );
}

function classifyPathUnderRoot(
  normalized: string,
  root: string,
): AgentsTreeClassification {
  if (normalized === root) {
    return { kind: "agents-root" };
  }

  if (normalized.startsWith(`${root}/`)) {
    const rest = normalized.slice(root.length + 1);
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    return { kind: "agent", id };
  }

  const prefix = normalized === "/" ? "/" : `${normalized}/`;
  if (root.startsWith(prefix)) {
    return { kind: "ancestor" };
  }

  return { kind: "outside" };
}

export function extractApplyPatchPaths(input: string): string[] {
  const paths: string[] = [];
  const fileDirectivePattern = /\*\*\* (?:Add|Update|Delete) File:\s*(.+)/g;
  const moveDirectivePattern = /\*\*\* Move to:\s*(.+)/g;

  for (const match of input.matchAll(fileDirectivePattern)) {
    const matchPath = match[1]?.trim();
    if (matchPath) paths.push(matchPath);
  }
  for (const match of input.matchAll(moveDirectivePattern)) {
    const matchPath = match[1]?.trim();
    if (matchPath) paths.push(matchPath);
  }

  return paths;
}

export function extractFilePath(toolArgs: ToolArgs): string | null {
  if (typeof toolArgs.file_path === "string" && toolArgs.file_path.length > 0) {
    return toolArgs.file_path;
  }
  if (typeof toolArgs.path === "string" && toolArgs.path.length > 0) {
    return toolArgs.path;
  }
  if (
    typeof toolArgs.notebook_path === "string" &&
    toolArgs.notebook_path.length > 0
  ) {
    return toolArgs.notebook_path;
  }
  return null;
}

const RECURSIVE_CANONICAL_TOOLS = new Set<string>(["Glob", "Grep", "ListDir"]);

function isRecursivePathTool(toolName: string): boolean {
  return RECURSIVE_CANONICAL_TOOLS.has(canonicalToolName(toolName));
}

export function extractTargetAgentPaths(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): CrossAgentTargets {
  const agentIds = new Set<string>();
  let anyAgentScoped = false;
  const recursive = isRecursivePathTool(toolName);
  const treeRoots = getCrossAgentTreeRoots(homeDir, env);
  const realTreeRoots = treeRoots.map((root) => canonicalizeRoot(root));

  const applyClassification = (classification: AgentsTreeClassification) => {
    switch (classification.kind) {
      case "outside":
        return;
      case "agents-root":
        anyAgentScoped = true;
        agentIds.add(UNRESOLVED_AGENT_ID);
        return;
      case "ancestor":
        if (recursive) {
          anyAgentScoped = true;
          agentIds.add(UNRESOLVED_AGENT_ID);
        }
        return;
      case "agent":
        anyAgentScoped = true;
        agentIds.add(classification.id);
        return;
    }
  };

  const addFromPath = (rawPath: string | null | undefined) => {
    if (!rawPath || typeof rawPath !== "string") return;
    const resolvedPath = resolveMemoryTargetPath(rawPath, workingDirectory);
    if (!resolvedPath) return;
    const lexical = normalizePathForCompare(resolvedPath);
    const real = canonicalizeRoot(resolvedPath);
    for (const root of treeRoots) {
      applyClassification(classifyPathUnderRoot(lexical, root));
    }
    for (const root of realTreeRoots) {
      applyClassification(classifyPathUnderRoot(real, root));
    }
  };

  if (toolName === "ApplyPatch") {
    if (typeof toolArgs.input === "string") {
      for (const p of extractApplyPatchPaths(toolArgs.input)) {
        addFromPath(p);
      }
    }
    return { agentIds, anyAgentScoped };
  }

  addFromPath(extractFilePath(toolArgs));

  if (recursive && typeof toolArgs.pattern === "string") {
    addFromPath(toolArgs.pattern);
  }

  return { agentIds, anyAgentScoped };
}

export interface CrossAgentGuardResult {
  matchedRule: "cross-agent guard";
  reason: string;
  offendingAgentIds: string[];
}

function buildReason(offending: string[], allowed: Set<string>): string {
  const offendingDesc = offending.join(", ");
  const allowedList = [...allowed];
  const allowedDesc =
    allowedList.length > 0 ? allowedList.join(", ") : "(none)";
  return (
    `Permission denied by cross-agent memory guard (${offendingDesc}). ` +
    `Allowed: ${allowedDesc}. ` +
    `Pass --disable-memory-guard from the parent agent process to opt in; ` +
    `subagents cannot disable this guard.`
  );
}

export function evaluateCrossAgentGuard(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  options: CrossAgentGuardOptions = {},
): CrossAgentGuardResult | null {
  const env = options.env ?? process.env;
  const homeDir = env.HOME ?? homedir();
  toolArgs = expandPathArgs(toolName, toolArgs, workingDirectory, env, homeDir);

  if (isMemoryGuardDisabled(options)) {
    return null;
  }

  if (isShellToolName(toolName) || canonicalToolName(toolName) === "Bash") {
    return null;
  }

  if (env.LETTA_CODE_AGENT_ROLE === "subagent" && env[SANDBOX_ENV_VAR]) {
    return null;
  }

  const targets = extractTargetAgentPaths(
    toolName,
    toolArgs,
    workingDirectory,
    env,
    homeDir,
  );

  const allowed = resolveAllowedAgents(options);
  const offending = new Set<string>();

  for (const id of targets.agentIds) {
    if (!allowed.has(id)) {
      offending.add(id);
    }
  }

  if (offending.size === 0) {
    return null;
  }

  const offendingList = [...offending];
  return {
    matchedRule: "cross-agent guard",
    reason: buildReason(offendingList, allowed),
    offendingAgentIds: offendingList,
  };
}
