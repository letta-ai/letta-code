import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  buildFsSandboxPolicy,
  type FsSandboxPolicy,
  normalizeSandboxPath,
} from "@/sandbox/policy";

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

/** Writable temp roots a sandboxed process realistically needs. */
function tempWritableRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = ["/tmp"];
  if (env.TMPDIR) roots.push(env.TMPDIR);
  return roots.map(canonicalizeRoot);
}

/** Whether a canonical path is the given root or nested inside it. */
function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
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
export function deriveSelfAgentRoots(
  memoryRoots: string[],
  agentsTreeRoot: string = getDefaultAgentsTreeRoot(),
): string[] {
  const out = new Set<string>();
  for (const root of memoryRoots) {
    const canon = canonicalizeRoot(root);
    if (canon !== agentsTreeRoot && isWithinRoot(canon, agentsTreeRoot)) {
      const leaf = basename(canon);
      out.add(
        leaf === "memory" || leaf === "memory-worktrees"
          ? dirname(canon)
          : canon,
      );
    } else {
      out.add(canon);
    }
  }
  return [...out];
}

export interface MemoryModeSandboxInput {
  /**
   * Memory roots the child may write to — typically the resolved
   * `MEMORY_DIR` plus its `memory-worktrees` sibling.
   */
  memoryRoots: string[];
  /** Additional writable roots (e.g. a backend storage dir). */
  extraWritableRoots?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Policy for a memory-mode subagent: it may read the filesystem broadly to do
 * its work and write *only* under its memory roots (and temp), and it may not
 * read or write *other* agents' memory.
 *
 * The whole subagent process runs under this policy, so it is the sole
 * enforcement for these agents — the static guard is skipped for them. That
 * means it must cover both axes:
 *   - writes: `restrictWrites` denies writes everywhere except `writableRoots`
 *     (the memory dir + temp).
 *   - cross-agent reads: the agents tree is read+write denied, with the agent's
 *     own (and inherited parent's) directory carved back out READ-only.
 *
 * Carving the whole agent *directory* readable — not just `/memory` — is what
 * lets us deny the tree without re-triggering the empty-env bug: the subagent's
 * cwd is its memory dir inside `~/.letta/agents`, and under Seatbelt a child
 * launches with an EMPTY environment if a cwd *ancestor* is read-denied. With
 * the agent dir (the cwd's immediate parent) readable, process init can
 * traverse to the cwd and the env survives. Writes stay scoped to `/memory`
 * because the readonly carve only re-allows reads (validated on darwin).
 */
export function buildMemoryModeSandboxPolicy(
  input: MemoryModeSandboxInput,
): FsSandboxPolicy {
  const env = input.env ?? process.env;
  const agentsTreeRoot = getDefaultAgentsTreeRoot();

  const writableRoots = [
    ...input.memoryRoots.map(canonicalizeRoot),
    ...(input.extraWritableRoots ?? []).map(canonicalizeRoot),
    ...tempWritableRoots(env),
  ];

  return buildFsSandboxPolicy({
    deniedRoots: [agentsTreeRoot],
    readonlyRoots: deriveSelfAgentRoots(input.memoryRoots, agentsTreeRoot),
    writableRoots,
    restrictWrites: true,
  });
}

export interface CrossAgentSandboxInput {
  /**
   * Directories the agent may freely read+write inside the walled-off agents
   * tree — typically its own agent directory (`~/.letta/agents/<self-id>`).
   */
  selfRoots: string[];
  /** The agents tree to wall off (read+write). Defaults to `~/.letta/agents`. */
  agentsTreeRoot?: string;
}

/**
 * Policy for a normal agent that may use the whole filesystem but must not read
 * or write *other* agents' memory. This is the kernel-enforced replacement for
 * the static cross-agent guard.
 *
 * Walls off the agents tree (read + write) and carves the agent's own directory
 * back out. Writes elsewhere — the repo, the home dir, temp — stay allowed
 * (`restrictWrites: false`): the only thing this policy removes is access to
 * other agents' memory, exactly like the guard it replaces.
 *
 * Unlike the memory-mode policy, this one DOES deny reads of the agents tree.
 * That is only safe when the process cwd is outside the tree (the parent
 * agent's cwd is the repo); a cwd inside a read-denied subtree launches with an
 * empty environment under Seatbelt. Callers must enforce that precondition.
 */
export function buildCrossAgentSandboxPolicy(
  input: CrossAgentSandboxInput,
): FsSandboxPolicy {
  const agentsTreeRoot = input.agentsTreeRoot
    ? canonicalizeRoot(input.agentsTreeRoot)
    : getDefaultAgentsTreeRoot();

  return buildFsSandboxPolicy({
    deniedRoots: [agentsTreeRoot],
    writableRoots: input.selfRoots.map(canonicalizeRoot),
    restrictWrites: false,
  });
}
