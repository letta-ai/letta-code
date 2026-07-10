import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  buildFsSandboxPolicy,
  type FsSandboxPolicy,
  normalizeSandboxPath,
} from "@/sandbox/policy";
import {
  getLocalBackendCrossAgentTreeRoot,
  getLocalBackendStorageDir,
} from "@/utils/local-backend-paths";

/**
 * Builders that translate agent/memory context into a concrete
 * {@link FsSandboxPolicy}. This is the bridge between the domain (agent ids,
 * memory roots) and the pure `@/sandbox` generators — it lives in
 * `permissions/` alongside the static guards it is meant to replace.
 *
 * Every root is canonicalized with realpath before it reaches a backend: both
 * Seatbelt and bwrap match rules against the kernel-resolved path, so a policy
 * built from a lexical path that passes through a symlink would silently match
 * nothing — i.e. a sandbox that allows everything. See `canonicalizeRoot`.
 */

/** The per-agent tree to wall off, e.g. `/Users/me/.letta/agents`. */
export function getDefaultAgentsTreeRoot(homeDir: string = homedir()): string {
  return canonicalizeRoot(join(homeDir, ".letta", "agents"));
}

export interface CrossBackendAgentsTreeRootsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit local backend storage dir, when already resolved by a caller. */
  localBackendStorageDir?: string | null;
}

/**
 * Every cross-agent memory tree the kernel sandbox must wall off. API/cloud
 * agents live under `~/.letta/agents`; local-backend agents live under
 * `<storage>/memfs`. A process running in either backend must deny both trees,
 * then carve back only the current/parent agent roots it is allowed to touch.
 */
export function getCrossBackendAgentsTreeRoots(
  options: CrossBackendAgentsTreeRootsOptions = {},
): string[] {
  const homeDir = options.homeDir ?? homedir();
  const localBackendStorageDir =
    options.localBackendStorageDir ??
    getLocalBackendStorageDir(homeDir, options.env ?? process.env);

  return [
    getDefaultAgentsTreeRoot(homeDir),
    canonicalizeRoot(getLocalBackendCrossAgentTreeRoot(localBackendStorageDir)),
  ];
}

/**
 * The harness state directory, e.g. `/Users/me/.letta`. Used as the broad
 * writable base for memory subagents: they may write harness metadata anywhere
 * under it (settings, logs, conversations, transcripts, memory) but not the
 * repo/home/temp — while the cross-agent tree nested inside it stays denied.
 */
export function getLettaHomeRoot(homeDir: string = homedir()): string {
  return canonicalizeRoot(join(homeDir, ".letta"));
}

/**
 * Resolve a path to the real (symlink-free) path the kernel will see. The leaf
 * may not exist yet (a file about to be created), so we realpath the nearest
 * existing ancestor and re-append the missing tail.
 */
export function canonicalizeRoot(input: string): string {
  const abs = isAbsolute(input) ? input : resolve(input);

  let dir = abs;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    tail.unshift(basename(dir));
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached the filesystem root without finding an existing ancestor.
      return normalizeSandboxPath(abs);
    }
    dir = parent;
  }

  try {
    const real = realpathSync(dir);
    return normalizeSandboxPath(tail.length ? join(real, ...tail) : real);
  } catch {
    return normalizeSandboxPath(abs);
  }
}

/** Whether a canonical path is the given root or nested inside it. */
function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isAncestorOfRoot(path: string, root: string): boolean {
  const prefix = path === "/" ? "/" : `${path}/`;
  return root.startsWith(prefix);
}

/**
 * True when a canonical path IS one of the trees or an ancestor of one. Such a
 * path must never be carved back out: re-exposing a whole tree (or an ancestor
 * that contains it) would re-expose the denied roots under bwrap's
 * last-mount-wins semantics, and is too broad under Seatbelt as well.
 */
function isTreeOrAncestorOfTree(
  path: string,
  canonicalTrees: string[],
): boolean {
  return canonicalTrees.some(
    (tree) => path === tree || isAncestorOfRoot(path, tree),
  );
}

/**
 * Resolve the caller-supplied agents trees (canonicalizing each), or fall back
 * to both backend trees when none were given. Shared by the policy builders.
 */
function resolveAgentsTreeRootsInput(roots?: string[]): string[] {
  return roots?.length
    ? roots.map(canonicalizeRoot)
    : getCrossBackendAgentsTreeRoots();
}

/**
 * Map memory roots to the agent directories to carve out of the walled-off
 * agents tree. A memory root under the tree
 * (`~/.letta/agents/<id>/memory[-worktrees]`) yields the whole agent dir
 * (`~/.letta/agents/<id>`); carving the *agent dir* rather than just `/memory`
 * keeps the cwd's immediate parent traversable, so a read-deny on the tree does
 * not empty the child env under Seatbelt. Roots outside the tree (a custom
 * `MEMORY_DIR`) are returned as-is.
 */
export function deriveSelfAgentRootsForTrees(
  memoryRoots: string[],
  agentsTreeRoots: string[] = getCrossBackendAgentsTreeRoots(),
): string[] {
  const canonicalTrees = agentsTreeRoots.map(canonicalizeRoot);
  const out = new Set<string>();
  for (const root of memoryRoots) {
    const canon = canonicalizeRoot(root);
    const containingTree = canonicalTrees.find(
      (tree) => canon !== tree && isWithinRoot(canon, tree),
    );
    if (containingTree) {
      // A memory root nested inside a tree: carve back the whole agent dir so
      // the cwd's immediate parent stays traversable (Seatbelt empty-env bug).
      const leaf = basename(canon);
      const parentLeaf = basename(dirname(canon));
      out.add(
        leaf === "memory" || leaf === "memory-worktrees"
          ? dirname(canon)
          : parentLeaf === "memory-worktrees" ||
              (parentLeaf === "memory" && leaf === ".git")
            ? dirname(dirname(canon))
            : canon,
      );
      continue;
    }
    // Outside every tree: keep as-is, unless it's a tree itself or an ancestor
    // of one (carving those back out would re-expose the denied tree).
    if (!isTreeOrAncestorOfTree(canon, canonicalTrees)) {
      out.add(canon);
    }
  }
  return [...out];
}

function deriveWritableMemoryRootsForTrees(
  memoryRoots: string[],
  agentsTreeRoots: string[],
): string[] {
  const canonicalTrees = agentsTreeRoots.map(canonicalizeRoot);
  const out = new Set<string>();
  for (const root of memoryRoots) {
    const canon = canonicalizeRoot(root);
    // Never re-carve a whole denied tree, or an ancestor that would re-expose
    // that tree under bwrap's last-mount-wins semantics.
    if (!isTreeOrAncestorOfTree(canon, canonicalTrees)) {
      out.add(canon);
    }
  }
  return [...out];
}

export interface MemorySubagentSandboxInput {
  /**
   * Memory roots the child may write to — typically the resolved
   * `MEMORY_DIR` plus its `memory-worktrees` sibling.
   */
  memoryRoots: string[];
  /** Additional roots to carve back read-only after denying agents trees. */
  readonlyRoots?: string[];
  /**
   * Harness state roots configured OUTSIDE `~/.letta` to also make writable —
   * `~/.letta` itself is always the base. The caller passes a custom
   * `LETTA_LOCAL_BACKEND_DIR` / `LETTA_TRANSCRIPT_ROOT` here so the in-process
   * child can still persist conversation/agent-state/transcripts when those are
   * relocated off the default tree. Usually empty (the defaults live under
   * `~/.letta`).
   */
  harnessWritableRoots?: string[];
  /**
   * The agents trees to wall off + carve self out of. Defaults to both
   * `~/.letta/agents` (API/cloud) and `lc-local-backend/memfs` (local). Each
   * agent's memory lives at `<tree>/<id>/memory` on both, so
   * {@link deriveSelfAgentRootsForTrees} carves the same way regardless of
   * backend.
   *
   * Resolved by the caller's layer (`tools/` / `agent/`, which may import
   * `backend/`): `permissions/` sits below `backend/`, so this builder takes the
   * already-resolved path rather than branching on a backend it cannot import.
   */
  agentsTreeRoots?: string[];
}

/**
 * Policy for the memory-subagent launch profile: it may read the filesystem broadly to do
 * its work, write only under the harness state dir (`~/.letta`), and not read or
 * write *other* agents' memory.
 *
 * The whole subagent process runs under this policy, so it is the sole
 * enforcement for these agents — the static guard is skipped for them. It covers
 * both axes:
 *   - writes: `restrictWrites` denies writes everywhere except the base
 *     `~/.letta` carve (and self memory). This scopes the agent's
 *     non-deterministic work — it can persist memory + harness metadata
 *     (settings, logs, conversations, transcripts) but cannot write the repo,
 *     home, or temp. Carving the WHOLE `~/.letta` rather than enumerating each
 *     harness file is deliberate: the harness writes many paths under it and the
 *     set is unbounded, so a per-file carve would silently break as new writers
 *     appear. The cross-agent tree nested inside `~/.letta` stays denied.
 *   - cross-agent reads: the agents tree is read+write denied, with the agent's
 *     own (and inherited parent's) directory carved back out READ-only.
 *
 * Carving the whole agent *directory* readable — not just `/memory` — is what
 * lets us deny the tree without re-triggering the empty-env bug: the subagent's
 * cwd is its memory dir inside the agents tree, and under Seatbelt a child
 * launches with an EMPTY environment if a cwd *ancestor* is read-denied. With
 * the agent dir (the cwd's immediate parent) readable, process init can traverse
 * to the cwd and the env survives.
 *
 * Both backend trees are denied by default so cloud/API agents cannot read local
 * agent memories and local agents cannot read cloud/API memories. Self memory is
 * re-carved writable in `writableRoots` because it is nested inside a denied
 * tree (the base `~/.letta` carve is overridden there by the deny).
 */
export function buildMemorySubagentSandboxPolicy(
  input: MemorySubagentSandboxInput,
): FsSandboxPolicy {
  const agentsTreeRoots = resolveAgentsTreeRootsInput(input.agentsTreeRoots);

  // Writes are scoped to the harness state dir. `~/.letta` is the always-on base
  // (covers settings/logs/conversations/transcripts/memory under the defaults);
  // `harnessWritableRoots` adds any harness root relocated OUTSIDE `~/.letta`
  // (custom LETTA_LOCAL_BACKEND_DIR / LETTA_TRANSCRIPT_ROOT). These are emitted
  // BEFORE the cross-agent deny, so the nested tree is still walled off.
  const baseWritableRoots = [
    getLettaHomeRoot(),
    ...(input.harnessWritableRoots ?? []),
  ].map(canonicalizeRoot);

  return buildFsSandboxPolicy({
    baseWritableRoots,
    deniedRoots: agentsTreeRoots,
    readonlyRoots: [
      ...deriveSelfAgentRootsForTrees(input.memoryRoots, agentsTreeRoots),
      ...(input.readonlyRoots ?? []).map(canonicalizeRoot),
    ],
    // Self memory is nested inside the denied tree; re-carve it writable so the
    // deny (which overrides the base ~/.letta carve there) is itself overridden.
    writableRoots: deriveWritableMemoryRootsForTrees(
      input.memoryRoots,
      agentsTreeRoots,
    ),
    restrictWrites: true,
  });
}

export interface CrossAgentSandboxInput {
  /**
   * Directories the agent may freely read+write inside the walled-off agents
   * tree — typically its own agent directory (`~/.letta/agents/<self-id>`).
   */
  selfRoots: string[];
  /** The agents trees to wall off (read+write). Defaults to both backends. */
  agentsTreeRoots?: string[];
}

/**
 * Policy for a normal agent that may use the whole filesystem but must not read
 * or write *other* agents' memory. This is the kernel-enforced replacement for
 * the static cross-agent guard.
 *
 * Walls off both backend agents trees (read + write) and carves the agent's own
 * directory back out. Writes elsewhere — the repo, the home dir, temp — stay
 * allowed (`restrictWrites: false`): the only thing this policy removes is
 * access to other agents' memory, exactly like the guard it replaces.
 *
 * Unlike the memory-subagent policy, this one DOES deny reads of the agents tree.
 * That is only safe when the process cwd is outside the tree (the parent
 * agent's cwd is the repo); a cwd inside a read-denied subtree launches with an
 * empty environment under Seatbelt. Callers must enforce that precondition.
 */
export function buildCrossAgentSandboxPolicy(
  input: CrossAgentSandboxInput,
): FsSandboxPolicy {
  const agentsTreeRoots = resolveAgentsTreeRootsInput(input.agentsTreeRoots);

  return buildFsSandboxPolicy({
    deniedRoots: agentsTreeRoots,
    writableRoots: input.selfRoots.map(canonicalizeRoot),
    restrictWrites: false,
  });
}
