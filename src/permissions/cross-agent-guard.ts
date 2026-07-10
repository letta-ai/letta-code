// src/permissions/cross-agent-guard.ts
// Cross-agent guard: hard-denies an in-process file tool whose target path
// resolves under another agent's memory directory.
//
// SCOPE — this guard now exists ONLY for agent-process IN-PROCESS file
// tools: Read / Write / Edit / MultiEdit / NotebookEdit / Glob / ListDir, the
// apply_patch family, and their Codex/Gemini aliases (all canonicalized via
// `canonicalToolName`, all carrying an explicit absolute path). These never
// fork, so the kernel filesystem sandbox (src/sandbox/) cannot see them.
//
// Spawned shell commands are intentionally no longer analyzed here (the old
// token/raw-command scanner is gone — it was bypassable by symlinks, command
// substitution, globbing, and subprocesses). When the opt-in cross-agent shell
// sandbox is enabled (`LETTA_FS_SANDBOX=1`), the kernel confines spawned
// shells instead; by default agent shells run unconfined. Subagents with the
// memory-subagent profile are confined as whole processes (default-on) and
// skip the guard entirely when the sandbox sentinel is set. The guard is the
// in-process safety net; the kernel is the enforcement boundary for opted-in
// shells and process-confined subagents.
//
// The guard runs BEFORE any other permission logic (decision step 0 in
// checkPermission). Its deny is unbypassable by modes and permission rules.
//
// Guarded access is limited to:
//   - self:   current AGENT_ID
//   - parent: explicit LETTA_PARENT_AGENT_ID for subagent processes
//
// Enabled by default for parent processes and subagents. --disable-memory-guard
// is parent-process only; subagents always evaluate the guard unless they are
// already kernel-confined as whole processes.

import { homedir } from "node:os";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import {
  getLocalBackendCrossAgentTreeRoot,
  getLocalBackendStorageDir,
} from "@/utils/local-backend-paths";
import { canonicalToolName, isShellToolName } from "./canonical";
import { cliPermissions } from "./cli-permissions-instance";
import { deriveAgentId, resolveMemoryTargetPath } from "./memory-paths";
import { canonicalizeRoot } from "./sandbox-policy";

// --------------------------------------------------------------------------
// Allowed agents
// --------------------------------------------------------------------------

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
  const env = options.env ?? process.env;
  if (isSubagentProcess(env)) return false;
  return options.disableMemoryGuard ?? cliPermissions.isMemoryGuardDisabled();
}

/**
 * Resolve the set of agent IDs a guarded process is allowed to operate
 * against without disabling the guard.
 */
export function resolveAllowedAgents(
  options: CrossAgentGuardOptions = {},
): Set<string> {
  const env = options.env ?? process.env;

  const self = deriveAgentId(env, options.currentAgentId);
  const parent = deriveParentAgentId(env);

  const ids = new Set<string>();
  if (self) ids.add(self);
  if (parent) ids.add(parent);

  return ids;
}

// --------------------------------------------------------------------------
// Target path extraction
// --------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

export interface CrossAgentTargets {
  /** Agent IDs extracted from any path references in the tool args. */
  agentIds: Set<string>;
  /**
   * True iff at least one target path resolved under a cross-agent memory tree
   * (`~/.letta/agents/<id>/...` on API, `<storage>/memfs/<id>/...` on local) —
   * the only case where the guard is concerned at all.
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
 * Classification of a path relative to a cross-agent memory tree:
 *  - `outside`     — path is unrelated to the tree.
 *  - `agents-root` — path is exactly the tree root (enumeration of every agent
 *                    on the machine).
 *  - `ancestor`    — path is an ancestor of the tree root (e.g. `$HOME`, `/`).
 *                    Recursive tools (Glob/ListDir) entering this path would
 *                    walk into other agents' directories.
 *  - `agent`       — path is inside a specific agent's directory (any depth,
 *                    including the bare agent dir). The `id` is the agent ID
 *                    component (the segment right under the tree root).
 */
export type AgentsTreeClassification =
  | { kind: "outside" }
  | { kind: "agents-root" }
  | { kind: "ancestor" }
  | { kind: "agent"; id: string };

/**
 * Every cross-agent memory tree on this machine, normalized. A target under any
 * of these (and not belonging to self/parent) is denied:
 *   - API backend:   `<home>/.letta/agents`
 *   - local backend: `<storage>/memfs` — storage is `$LETTA_LOCAL_BACKEND_DIR`
 *     or `<home>/.letta/lc-local-backend`
 * Both share the `<root>/<agentId>/...` shape, so {@link classifyPathUnderRoot}
 * resolves the agent id regardless of backend. The local root is always included
 * (a no-op when local backend is unused — no files live there) so a single agent
 * can't read a *local* peer's memory via in-process Read/Edit/Write even though
 * the kernel sandbox can't see those non-forking tools.
 */
function getCrossAgentTreeRoots(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  return [
    getAgentsTreeRoot(homeDir),
    normalizePathForCompare(
      getLocalBackendCrossAgentTreeRoot(
        getLocalBackendStorageDir(homeDir, env),
      ),
    ),
  ];
}

/**
 * Structural classification of a normalized path relative to a normalized
 * tree root. Both inputs must already be canonical (forward slashes, no
 * trailing slash) — the caller decides whether that means lexical or realpath.
 */
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
  // Gemini's glob_gemini / search_file_content / list_directory pass their search
  // root as `dir_path` (the handler renames it to `path` only at execution time,
  // after this approval-time check). Read it here so cross-agent enumeration via
  // those tools is caught for every toolset.
  if (typeof toolArgs.dir_path === "string" && toolArgs.dir_path.length > 0) {
    return toolArgs.dir_path;
  }
  return null;
}

function extractMultiEditPaths(toolArgs: ToolArgs): string[] {
  // MultiEdit uses file_path (singular), but callers occasionally pass an
  // `edits` array. Either way the paths come from the top-level `file_path`.
  const single = extractFilePath(toolArgs);
  return single ? [single] : [];
}

/**
 * Tools whose semantics imply a recursive walk from the given path
 * (as opposed to touching a single file). When one of these is pointed
 * at an *ancestor* of the agents tree, the walk would expose every
 * agent on disk — so we treat ancestor paths as hits for these tools.
 *
 * Compared against the canonical tool name (so Gemini's `glob_gemini` /
 * `list_directory` and the `LS` alias all fold into Glob/ListDir).
 */
const RECURSIVE_CANONICAL_TOOLS = new Set<string>(["Glob", "ListDir", "Grep"]);

function isRecursivePathTool(toolName: string): boolean {
  return RECURSIVE_CANONICAL_TOOLS.has(canonicalToolName(toolName));
}

/**
 * Extract the agent IDs referenced by the target paths of an in-process file
 * tool call. Returns `anyAgentScoped: false` for tool calls that don't touch
 * agent memory at all (the guard's fast path). Shell tools are NOT handled
 * here — the kernel sandbox confines spawned shells.
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
  // Both the API and local-backend cross-agent trees, plus their realpath form
  // (resolving symlinks; tolerating a not-yet-existing leaf for create-file).
  const treeRoots = getCrossAgentTreeRoots(homeDir, env);
  const realTreeRoots = treeRoots.map((root) => canonicalizeRoot(root));

  const applyClassification = (classification: AgentsTreeClassification) => {
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
        // given path (Glob/ListDir). Single-file tools like Read
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

  const addFromPath = (rawPath: string | null | undefined) => {
    if (!rawPath || typeof rawPath !== "string") return;
    const resolvedPath = resolveMemoryTargetPath(rawPath, workingDirectory);
    if (!resolvedPath) return;
    // Classify against every cross-agent tree (API + local). The lexical pass
    // preserves string-match behavior; the realpath pass follows symlinks so a
    // link whose real target lands in another agent's memory can't slip past.
    // Everything unions via the shared `agentIds` set — extra passes only add
    // denials, never remove them.
    const lexical = normalizePathForCompare(resolvedPath);
    const real = canonicalizeRoot(resolvedPath);
    for (const root of treeRoots) {
      applyClassification(classifyPathUnderRoot(lexical, root));
    }
    for (const root of realTreeRoots) {
      applyClassification(classifyPathUnderRoot(real, root));
    }
  };

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

  // MultiEdit: same path semantics as Edit.
  if (toolName === "MultiEdit") {
    for (const p of extractMultiEditPaths(toolArgs)) {
      addFromPath(p);
    }
    return { agentIds, anyAgentScoped };
  }

  // All other in-process file tools: Read/Write/Edit/NotebookEdit/Glob/
  // ListDir + Gemini + Codex aliases (all converge on file_path / path /
  // notebook_path after the toolset adapters).
  addFromPath(extractFilePath(toolArgs));

  // Glob also accepts a `pattern` arg. An absolute pattern like
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

/**
 * Evaluate whether an in-process file tool call should be hard-denied because
 * it targets another agent's memory. Returns null when the guard is not
 * concerned.
 *
 * Shell tools are not evaluated: spawned shells are confined by the kernel
 * filesystem sandbox. A subagent confined as a whole process by the kernel
 * (sandbox sentinel set) is also skipped — its every tool, in-process file ops
 * included, is already kernel-isolated.
 */
export function evaluateCrossAgentGuard(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  options: CrossAgentGuardOptions = {},
): CrossAgentGuardResult | null {
  const env = options.env ?? process.env;
  const homeDir = env.HOME ?? homedir();

  if (isMemoryGuardDisabled(options)) {
    return null;
  }

  // Spawned shells are confined by the kernel sandbox; the bypassable static
  // shell analysis this guard used to do is gone.
  if (isShellToolName(toolName) || canonicalToolName(toolName) === "Bash") {
    return null;
  }

  // A subagent confined as a whole process by the kernel sandbox (sentinel set)
  // has cross-agent isolation enforced for *every* tool — including in-process
  // file ops — so the static guard is fully redundant.
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
