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
import { canonicalToolName, isShellToolName } from "./canonical";
import { cliPermissions } from "./cli";
import {
  deriveAgentId,
  normalizeScopedPath,
  parseScopeList,
  resolveScopedTargetPath,
} from "./memoryScope";
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

/**
 * Resolve the set of agent IDs the current process is allowed to operate
 * against. Additive union of three sources.
 */
export function resolveAllowedAgents(
  options: AllowedAgentsOptions = {},
): ResolvedAllowedAgents {
  const env = options.env ?? process.env;

  const self = deriveAgentId(env, options.currentAgentId);
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
 * Sentinel ID used when a path touches the agents tree but we can't
 * resolve it to a single agent — e.g. the bare agents-tree root (an
 * enumeration attempt) or a recursive-search root that would walk into
 * the tree. The guard treats this as never-allowed, so any such path
 * is denied unless upstream knew what agent to filter to.
 */
const UNRESOLVED_AGENT_ID = "<unresolved>";

/**
 * Escape a string for use inside a regex.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The agents-tree root on this machine, e.g. `/home/user/.letta/agents`,
 * normalized (forward slashes, no trailing slash).
 */
function getAgentsTreeRoot(homeDir: string): string {
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${normalizedHome}/.letta/agents`;
}

/**
 * Normalize a path for structural comparison: forward slashes, no
 * trailing slash, preserving a bare `/` as root.
 */
function normalizePathForCompare(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.length === 0 ? "/" : normalized;
}

/**
 * Classification of a path relative to the agents tree:
 *  - `outside`     — path is unrelated to the agents tree.
 *  - `agents-root` — path is exactly `<home>/.letta/agents` (enumeration of
 *                    every agent on the machine).
 *  - `ancestor`    — path is an ancestor of the agents tree (e.g. `$HOME`,
 *                    `/`). Recursive tools (Grep/Glob) entering this path
 *                    would walk into other agents' directories.
 *  - `agent`       — path is inside a specific agent's directory (any
 *                    depth, including the bare agent dir, not just
 *                    `/memory`). The `id` is the agent ID component.
 */
export type AgentsTreeClassification =
  | { kind: "outside" }
  | { kind: "agents-root" }
  | { kind: "ancestor" }
  | { kind: "agent"; id: string };

/**
 * Classify a path relative to the agents tree. See
 * {@link AgentsTreeClassification} for the kinds.
 */
export function classifyAgentsTreePath(
  path: string,
  homeDir: string,
): AgentsTreeClassification {
  const root = getAgentsTreeRoot(homeDir);
  const normalized = normalizePathForCompare(path);

  if (normalized === root) {
    return { kind: "agents-root" };
  }

  if (normalized.startsWith(`${root}/`)) {
    const rest = normalized.slice(root.length + 1);
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    return { kind: "agent", id };
  }

  // Is `normalized` an ancestor of the agents-tree root?
  // A recursive walk starting at `normalized` would eventually enter
  // `<root>/`, exposing every agent on the machine.
  const prefix = normalized === "/" ? "/" : `${normalized}/`;
  if (root.startsWith(prefix)) {
    return { kind: "ancestor" };
  }

  return { kind: "outside" };
}

/**
 * Extract file directives from an apply_patch / memory_apply_patch input.
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
 * Regex that matches `$NAME` or `${NAME}` shell variable references.
 * Capture group 1 is the braced name, group 2 is the bare name.
 */
const SHELL_VAR_REGEX =
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Look up a shell variable name. Returns the env value, or `homeDir` for
 * the `HOME` special-case, or undefined if unresolved.
 */
function lookupShellVar(
  name: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string | undefined {
  if (name === "HOME") return homeDir;
  const value = env[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Expand env variables ($VAR, ${VAR}, $HOME, ~/) in a shell token.
 * Returns null when an unresolved variable is encountered (so the caller
 * skips the token rather than scanning a partially-resolved string).
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
    SHELL_VAR_REGEX,
    (_match, bracedName: string | undefined, bareName: string | undefined) => {
      const name = bracedName || bareName;
      if (!name) {
        unresolved = true;
        return "";
      }
      const value = lookupShellVar(name, env, homeDir);
      if (value === undefined) {
        unresolved = true;
        return "";
      }
      return value;
    },
  );

  return unresolved ? null : result;
}

/**
 * Walk a shell command and collect every token that expands to an
 * agent-scoped memory path on this machine. Returns the map of
 * token → agent ID.
 *
 * If `splitShellSegments` refuses the command (dangerous operator,
 * command substitution, non-/dev/null redirect, etc.), we still scan
 * the raw tokens of the whole command as a best-effort safety net —
 * any agent-scoped path in there is still a hit.
 */
function collectShellAgentTargets(
  command: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Map<string, string> {
  const targets = new Map<string, string>();
  const segments = splitShellSegments(command) ?? [command];
  for (const segment of segments) {
    for (const token of tokenizeShellWords(segment)) {
      scanToken(token, env, homeDir, targets);
    }
  }
  return targets;
}

/**
 * Strip every matched pair of surrounding quotes from a value.
 *
 * Shell tokens may come through as `"$TARGET"`, `'$TARGET'`, or nested
 * `""$TARGET""` depending on how the command was written. The upstream
 * `stripShellQuotes` only strips a single outer pair; we loop to handle
 * repeated wrappings so the anchored path regex can still match.
 */
function stripAllOuterQuotes(value: string): string {
  let result = value;
  while (
    result.length >= 2 &&
    ((result.startsWith('"') && result.endsWith('"')) ||
      (result.startsWith("'") && result.endsWith("'")))
  ) {
    result = result.slice(1, -1);
  }
  return result;
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
  const candidates = [rawToken, candidateValue]
    .filter((v) => v.length > 0)
    // Remove matched outer quotes so the anchored path regex matches.
    .map((v) => stripAllOuterQuotes(v));

  for (const value of candidates) {
    const expanded = expandShellToken(value, env, homeDir);
    if (expanded === null) continue;
    const normalized = normalizeScopedPath(expanded);
    const classification = classifyAgentsTreePath(normalized, homeDir);
    if (classification.kind === "agent") {
      out.set(value, classification.id);
    } else if (classification.kind === "agents-root") {
      // Bare agents-tree root in a shell token — enumeration.
      out.set(value, UNRESOLVED_AGENT_ID);
    }
    // "ancestor" is intentionally ignored for shell tokens: the Bash
    // raw-command scan handles those cases, and most legitimate shell
    // commands have tokens that are ancestors of the agents tree
    // (e.g. `$HOME`, `/`) without being a threat by themselves.
  }
}

/**
 * Conservative scan of the raw shell command for any reference to the
 * agents tree. Complements the tokenizer by catching patterns that
 * static analysis can't resolve:
 *   - `ls ~/.letta/agents` (enumeration)
 *   - `find $HOME/.letta/agents -type d` (globbing)
 *   - `TARGET="$(find ~/.letta/agents ...)"; cat "$TARGET/..."` (command
 *     substitution — tokenizer can't follow)
 *   - assignment-then-use where the literal agent ID appears in the raw
 *     string even if our static expander can't trace the variable.
 *
 * The scan is home-anchored: only references to agent paths under the
 * current user's home dir trigger it. References to other homes (e.g.
 * test fixtures under `/Users/test/.letta/agents/...`) are ignored —
 * they can't possibly touch real data on this machine.
 *
 * Any occurrence of `<home>/.letta/agents/<id>` where `<id>` is not in
 * `allowedAgentIds` (or is empty / a shell variable / a glob) produces
 * an entry in the returned list. The guard then hard-denies.
 */
function scanRawCommandForUnresolvedAgentRefs(
  rawCommand: string,
  allowedAgentIds: Set<string>,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string[] {
  // Pre-expand $VAR / ${VAR} / $HOME / ~ on the whole command so that
  // self-targeting references like `~/.letta/agents/${AGENT_ID}/memory`
  // don't falsely trip the scan.
  const expanded = expandCommandVariables(rawCommand, env, homeDir);

  // Home-anchored pattern: match only references rooted at the current
  // user's agents tree. Group 1 is the agent-ID candidate (optional).
  //
  // The terminator class includes `/`, whitespace, quotes, common shell
  // syntax (`$`, `(`, `)`, `{`, `}`, `[`, `]`, `;`, `|`, `&`, `,`, `\``,
  // and `#`) so we stop at a word boundary.
  const escapedRoot = escapeRegex(getAgentsTreeRoot(homeDir));
  const pattern = new RegExp(
    `${escapedRoot}(?:/([^/\\s"'\`$(){}\\[\\]|&;,#]*))?`,
    "g",
  );

  const unresolved: string[] = [];
  for (const match of expanded.matchAll(pattern)) {
    const candidate = (match[1] ?? "").trim();
    if (candidate.length === 0) {
      // Bare `<home>/.letta/agents` or `.../agents/` — enumeration of
      // the whole agents tree. Always suspicious.
      unresolved.push(UNRESOLVED_AGENT_ID);
      continue;
    }
    if (!allowedAgentIds.has(candidate)) {
      unresolved.push(candidate);
    }
  }
  return unresolved;
}

/**
 * Expand env vars on the raw command string (best effort). Unlike
 * `expandShellToken`, this leaves unresolved `$VAR` references intact
 * so they still register as "unresolved" during the raw scan.
 */
function expandCommandVariables(
  command: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  // Replace ~/ only when it follows whitespace, a quote, `=`, `:`, or start.
  let result = command.replace(
    /(^|[\s="'`:])~\//g,
    (_match, prefix: string) => `${prefix}${homeDir}/`,
  );
  // Replace $VAR / ${VAR} with env values when known; keep literal otherwise.
  result = result.replace(
    SHELL_VAR_REGEX,
    (match, bracedName: string | undefined, bareName: string | undefined) => {
      const name = bracedName || bareName;
      if (!name) return match;
      return lookupShellVar(name, env, homeDir) ?? match;
    },
  );
  return result;
}

/**
 * Tools whose semantics imply a recursive walk from the given path
 * (as opposed to touching a single file). When one of these is pointed
 * at an *ancestor* of the agents tree, the walk would expose every
 * agent on disk — so we treat ancestor paths as hits for these tools.
 */
const RECURSIVE_PATH_TOOLS = new Set<string>([
  "Grep",
  "Glob",
  "ListDir",
  "LS",
  "list_dir",
  "grep",
  "glob",
]);

function isRecursivePathTool(toolName: string): boolean {
  if (RECURSIVE_PATH_TOOLS.has(toolName)) return true;
  const canonical = canonicalToolName(toolName);
  return RECURSIVE_PATH_TOOLS.has(canonical);
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
  const recursive = isRecursivePathTool(toolName);

  const addFromPath = (rawPath: string | null | undefined) => {
    if (!rawPath || typeof rawPath !== "string") return;
    const resolvedPath = resolveScopedTargetPath(rawPath, workingDirectory);
    if (!resolvedPath) return;
    const classification = classifyAgentsTreePath(resolvedPath, homeDir);
    switch (classification.kind) {
      case "outside":
        return;
      case "agents-root":
        // Targeting the agents tree root itself — enumeration.
        anyAgentScoped = true;
        agentIds.add(UNRESOLVED_AGENT_ID);
        return;
      case "ancestor":
        // Only dangerous for tools that recursively walk from the
        // given path (Grep/Glob/ListDir). Single-file tools like Read
        // can't escape their target.
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

  // Grep / Glob also accept a `pattern` arg. An absolute pattern like
  // `/home/user/.letta/agents/**/*.md` would bypass the `path` check
  // entirely. Run the pattern through the same resolver.
  if (recursive && typeof toolArgs.pattern === "string") {
    addFromPath(toolArgs.pattern);
  }

  return { agentIds, anyAgentScoped };
}

// --------------------------------------------------------------------------
// Guard evaluation
// --------------------------------------------------------------------------

export interface CrossAgentGuardResult {
  matchedRule: "cross-agent guard";
  reason: string;
  offendingAgentIds: string[];
}

function buildReason(
  offending: string[],
  allowed: ResolvedAllowedAgents,
): string {
  const offendingDesc = offending.join(", ");
  const allowedList = [...allowed.ids];
  const allowedDesc =
    allowedList.length > 0 ? allowedList.join(", ") : "(none)";
  return (
    `Permission denied by cross-agent memory guard (${offendingDesc}). ` +
    `Allowed: ${allowedDesc}. ` +
    `Set LETTA_MEMORY_SCOPE or pass --memory-scope to opt in.`
  );
}

/**
 * Evaluate whether a tool call should be hard-denied because it targets
 * another agent's memory. Returns null when the guard is not concerned.
 *
 * Shell tools are checked twice:
 *   1. Token-level extraction of statically-resolvable paths.
 *   2. Raw-command regex scan that denies any unresolved / not-allowed
 *      `.letta/agents/<id>` reference, catching command substitution,
 *      globbing, and enumeration patterns that static analysis can't
 *      reliably trace.
 */
export function evaluateCrossAgentGuard(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  options: AllowedAgentsOptions = {},
): CrossAgentGuardResult | null {
  const env = options.env ?? process.env;
  const homeDir = env.HOME ?? homedir();

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
    if (!allowed.ids.has(id)) {
      offending.add(id);
    }
  }

  // Shell tools additionally get a conservative raw-command scan.
  const canonical = canonicalToolName(toolName);
  if (isShellToolName(toolName) || canonical === "Bash") {
    const command = extractShellCommand(toolArgs);
    if (command) {
      const unresolved = scanRawCommandForUnresolvedAgentRefs(
        command,
        allowed.ids,
        env,
        homeDir,
      );
      for (const id of unresolved) {
        offending.add(id);
      }
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
