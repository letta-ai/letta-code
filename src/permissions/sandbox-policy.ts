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
 * Policy for a memory-mode subagent: it may read the filesystem to do its work
 * but may write *only* under its memory roots (and temp).
 *
 * Deliberately does NOT deny reads of the agents tree. "Memory mode" is a
 * write restriction ("writes go only to the memory dir"); cross-agent *read*
 * isolation is a separate concern handled by the cross-agent guard. Critically,
 * a memory subagent runs with its cwd set to the memory dir, which lives inside
 * `~/.letta/agents`: under Seatbelt, a `(deny file-read*)` on a cwd ancestor
 * makes the child launch with an EMPTY environment (macOS can't traverse the
 * read-denied path during process init), which would break the subagent
 * entirely. `restrictWrites` alone already prevents writing to other agents
 * (they are not in `writableRoots`), so no read-deny is needed here.
 */
export function buildMemoryModeSandboxPolicy(
  input: MemoryModeSandboxInput,
): FsSandboxPolicy {
  const env = input.env ?? process.env;

  const writableRoots = [
    ...input.memoryRoots.map(canonicalizeRoot),
    ...(input.extraWritableRoots ?? []).map(canonicalizeRoot),
    ...tempWritableRoots(env),
  ];

  return buildFsSandboxPolicy({
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
