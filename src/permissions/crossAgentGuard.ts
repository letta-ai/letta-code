// src/permissions/crossAgentGuard.ts
// Cross-agent guard: hard-denies any tool call whose target resolves under
// another agent's memory directory unless the caller has explicitly opted in.
//
// The guard runs BEFORE any other permission logic (mode overrides, CLI
// allow/deny rules, settings rules). Its deny is unbypassable — no mode,
// no rule, no flag can override it.
//
// Sources for the allowed-agents set (additive, deduped):
//   - self:  current AGENT_ID
//   - env:   LETTA_MEMORY_SCOPE (comma- or whitespace-separated agent IDs)
//   - cli:   --memory-scope flag (via cliPermissions.getMemoryScope())

import { homedir } from "node:os";
import { getCurrentAgentId } from "../agent/context";
import { canonicalToolName, isShellToolName } from "./canonical";
import { cliPermissions } from "./cli";
import { normalizeScopedPath, resolveScopedTargetPath } from "./memoryScope";
import { splitShellSegments, tokenizeShellWords } from "./shellAnalysis";

// --------------------------------------------------------------------------
// Allowed agents
// --------------------------------------------------------------------------

export interface AllowedAgentsOptions {
  env?: NodeJS.ProcessEnv;
  currentAgentId?: string | null;
  cliMemoryScope?: string[];
}

export interface ResolvedAllowedAgents {
  ids: Set<string>;
  sources: {
    self: string | null;
    env: string[];
    cli: string[];
  };
}

function parseScopeList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function deriveSelfAgentId(
  env: NodeJS.ProcessEnv,
  explicit?: string | null,
): string | null {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;

  const fromEnv = (env.AGENT_ID || env.LETTA_AGENT_ID || "").trim();
  if (fromEnv) return fromEnv;

  try {
    const fromContext = getCurrentAgentId().trim();
    return fromContext || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the set of agent IDs the current process is allowed to operate
 * against. Additive union of three sources.
 */
export function resolveAllowedAgents(
  options: AllowedAgentsOptions = {},
): ResolvedAllowedAgents {
  const env = options.env ?? process.env;

  const self = deriveSelfAgentId(env, options.currentAgentId);
  const envScope = parseScopeList(env.LETTA_MEMORY_SCOPE);
  const cliScope = options.cliMemoryScope ?? cliPermissions.getMemoryScope();

  const ids = new Set<string>();
  if (self) ids.add(self);
  for (const id of envScope) ids.add(id);
  for (const id of cliScope) ids.add(id);

  return {
    ids,
    sources: {
      self,
      env: envScope,
      cli: [...cliScope],
    },
  };
}

// --------------------------------------------------------------------------
// Target path extraction
// --------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

export interface CrossAgentTargets {
  /** Agent IDs extracted from any path references in the tool args. */
  agentIds: Set<string>;
  /**
   * True iff at least one target path resolved under
   * ~/.letta/agents/<id>/memory(-worktrees)?/... — the only case where
   * the guard is concerned at all.
   */
  anyAgentScoped: boolean;
}

/**
 * Build the regex that matches an agent-scoped memory path prefix on the
 * current machine. Capture group 1 is the agent ID.
 *
 * Uses the canonical home dir so we only need to compile once per call.
 */
function buildAgentScopedRegex(homeDir: string): RegExp {
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const escaped = normalizedHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped}/\\.letta/agents/([^/]+)/memory(?:-worktrees)?(?:/.*)?$`,
  );
}

/**
 * If the given path is agent-scoped on this machine, return the agent ID.
 */
function matchAgentScopedPath(path: string, homeDir: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const regex = buildAgentScopedRegex(homeDir);
  const match = normalized.match(regex);
  return match?.[1] ?? null;
}

/**
 * Extract file directives from an apply_patch / memory_apply_patch input.
 *
 * Exported so `mode.ts` can also share this helper (single source of truth
 * for the directive syntax).
 */
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

function extractFilePath(toolArgs: ToolArgs): string | null {
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

function extractMultiEditPaths(toolArgs: ToolArgs): string[] {
  // MultiEdit uses file_path (singular), but callers occasionally pass an
  // `edits` array. Either way the paths come from the top-level `file_path`.
  const single = extractFilePath(toolArgs);
  return single ? [single] : [];
}

function extractShellCommand(toolArgs: ToolArgs): string | null {
  const command = toolArgs.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    return command.map((c) => String(c)).join(" ");
  }
  return null;
}

/**
 * Expand env variables ($VAR, ${VAR}, $HOME, ~/) in a shell token.
 * Returns null when an unresolved variable is encountered.
 *
 * Mirrors the expansion used by `readOnlyShell.ts#expandScopedVariables`
 * but is self-contained here to keep the dependency graph simple.
 */
function expandShellToken(
  token: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string | null {
  let result = token;

  if (result.startsWith("~/")) {
    result = `${homeDir}/${result.slice(2)}`;
  } else if (result === "~") {
    result = homeDir;
  }

  let unresolved = false;
  result = result.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, bracedName: string | undefined, bareName: string | undefined) => {
      const name = bracedName || bareName;
      if (!name) {
        unresolved = true;
        return "";
      }
      if (name === "HOME") {
        return homeDir;
      }
      const envValue = env[name];
      if (typeof envValue === "string") {
        return envValue;
      }
      unresolved = true;
      return "";
    },
  );

  return unresolved ? null : result;
}

/**
 * Walk a shell command and collect every token that expands to an
 * agent-scoped memory path on this machine. Returns the map of
 * token → agent ID.
 */
function collectShellAgentTargets(
  command: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Map<string, string> {
  const targets = new Map<string, string>();
  const segments = splitShellSegments(command);
  if (!segments) {
    // Split was refused due to dangerous operator (command substitution,
    // redirect to non-/dev/null, etc.). Still scan the raw tokens of the
    // whole command as best-effort — if any agent-scoped path shows up,
    // we want to catch it.
    const tokens = tokenizeShellWords(command);
    for (const token of tokens) {
      scanToken(token, env, homeDir, targets);
    }
    return targets;
  }

  for (const segment of segments) {
    const tokens = tokenizeShellWords(segment);
    for (const token of tokens) {
      scanToken(token, env, homeDir, targets);
    }
  }
  return targets;
}

function scanToken(
  rawToken: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  out: Map<string, string>,
): void {
  if (!rawToken) return;

  // Strip leading assignment prefix (FOO=...) so we also catch values
  // assigned to env variables inline.
  const assignmentMatch = rawToken.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  const candidateValue = assignmentMatch
    ? (assignmentMatch[2] ?? "")
    : rawToken;
  const candidates = [rawToken, candidateValue].filter((v) => v.length > 0);

  for (const value of candidates) {
    const expanded = expandShellToken(value, env, homeDir);
    if (expanded === null) continue;
    const normalized = normalizeScopedPath(expanded);
    const agentId = matchAgentScopedPath(normalized, homeDir);
    if (agentId) {
      out.set(value, agentId);
    }
  }
}

/**
 * Extract the agent IDs referenced by the targets of a tool call.
 * Returns `anyAgentScoped: false` for tool calls that don't touch
 * agent memory at all (the guard's fast path).
 */
export function extractTargetAgentPaths(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): CrossAgentTargets {
  const agentIds = new Set<string>();
  let anyAgentScoped = false;

  const addFromPath = (rawPath: string | null | undefined) => {
    if (!rawPath || typeof rawPath !== "string") return;
    const resolvedPath = resolveScopedTargetPath(rawPath, workingDirectory);
    if (!resolvedPath) return;
    const id = matchAgentScopedPath(resolvedPath, homeDir);
    if (id) {
      anyAgentScoped = true;
      agentIds.add(id);
    }
  };

  const canonical = canonicalToolName(toolName);

  // Patch tools: extract every file directive.
  if (
    toolName === "ApplyPatch" ||
    toolName === "apply_patch" ||
    toolName === "memory_apply_patch"
  ) {
    if (typeof toolArgs.input === "string") {
      for (const p of extractApplyPatchPaths(toolArgs.input)) {
        addFromPath(p);
      }
    }
    return { agentIds, anyAgentScoped };
  }

  // Shell tools: tokenize + expand.
  if (isShellToolName(toolName) || canonical === "Bash") {
    const command = extractShellCommand(toolArgs);
    if (command) {
      const hits = collectShellAgentTargets(command, env, homeDir);
      for (const id of hits.values()) {
        anyAgentScoped = true;
        agentIds.add(id);
      }
    }
    return { agentIds, anyAgentScoped };
  }

  // MultiEdit: same path semantics as Edit.
  if (toolName === "MultiEdit") {
    for (const p of extractMultiEditPaths(toolArgs)) {
      addFromPath(p);
    }
    return { agentIds, anyAgentScoped };
  }

  // All other file-oriented tools: Read/Write/Edit/NotebookEdit/Glob/
  // Grep/ListDir/LS + Gemini + Codex aliases.
  addFromPath(extractFilePath(toolArgs));

  return { agentIds, anyAgentScoped };
}

// --------------------------------------------------------------------------
// Guard evaluation
// --------------------------------------------------------------------------

export interface CrossAgentGuardResult {
  matchedRule: "cross-agent guard";
  reason: string;
  offendingAgentId: string;
  offendingAgentIds: string[];
}

function buildReason(
  offending: string[],
  allowed: ResolvedAllowedAgents,
): string {
  const allowedList = [...allowed.ids];
  const allowedDesc =
    allowedList.length > 0 ? allowedList.join(", ") : "(none)";
  const offendingDesc = offending.join(", ");
  const plural = offending.length > 1 ? "agents" : "agent";
  return (
    `Cross-agent guard: refusing to touch memory belonging to ${plural} ` +
    `${offendingDesc}. Allowed agents: ${allowedDesc}. ` +
    `Set LETTA_MEMORY_SCOPE or pass --memory-scope to opt in.`
  );
}

/**
 * Evaluate whether a tool call should be hard-denied because it targets
 * another agent's memory. Returns null when the guard is not concerned.
 */
export function evaluateCrossAgentGuard(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  options: AllowedAgentsOptions = {},
): CrossAgentGuardResult | null {
  const env = options.env ?? process.env;
  const targets = extractTargetAgentPaths(
    toolName,
    toolArgs,
    workingDirectory,
    env,
  );

  if (!targets.anyAgentScoped) {
    return null;
  }

  const allowed = resolveAllowedAgents(options);
  const offending: string[] = [];
  for (const id of targets.agentIds) {
    if (!allowed.ids.has(id)) {
      offending.push(id);
    }
  }

  if (offending.length === 0) {
    return null;
  }

  return {
    matchedRule: "cross-agent guard",
    reason: buildReason(offending, allowed),
    offendingAgentId: offending[0] ?? "",
    offendingAgentIds: offending,
  };
}
