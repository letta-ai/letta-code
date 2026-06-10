import { isAbsolute, resolve } from "node:path";

/**
 * A filesystem sandbox policy, expressed entirely in concrete absolute paths.
 *
 * This module is a pure leaf: it knows nothing about agents, memory modes, or
 * how paths are derived. Callers resolve agent ids / memory roots into paths
 * (via `@/permissions/memory-paths`) and hand the finished policy here. That
 * keeps the OS-specific generators (`seatbelt.ts`, `bwrap.ts`) trivially
 * testable and out of the domain layer graph.
 *
 * Enforcement semantics (both backends implement the same model):
 *
 *   - `deniedRoots`     read + write denied (e.g. `~/.letta/agents`).
 *   - `readonlyRoots`   read re-allowed, write stays denied. Overrides denied.
 *   - `writableRoots`   read + write re-allowed. Overrides denied and the
 *                       global write-deny below.
 *   - `restrictWrites`  when true, writes are denied *everywhere* except
 *                       `writableRoots` (memory mode). When false, writes are
 *                       allowed by default except under `deniedRoots`
 *                       (cross-agent mode — the normal agent that simply may
 *                       not touch other agents' memory).
 *
 * Reads are never globally restricted: an agent can read the whole filesystem
 * to do its work, minus the other-agent directories in `deniedRoots`.
 *
 * Specificity is expressed through ordering, not nesting depth: a `writableRoot`
 * inside a `deniedRoot` (self memory inside the agents tree) is restored because
 * its allow rule is emitted *after* the deny.
 */
export interface FsSandboxPolicy {
  deniedRoots: string[];
  readonlyRoots: string[];
  writableRoots: string[];
  restrictWrites: boolean;
}

/** Backend tag, also the value of the `LETTA_SANDBOX` env sentinel. */
export type SandboxBackend = "seatbelt" | "bwrap";

/**
 * Env var set inside a sandboxed process. Mirrors Codex's `CODEX_SANDBOX`.
 * Tools and nested logic can read it to detect that they are already confined
 * (and, for the re-exec pattern, to avoid wrapping themselves twice).
 */
export const SANDBOX_ENV_VAR = "LETTA_SANDBOX";

export interface BuildPolicyOptions {
  /** Root of the per-agent tree to wall off, e.g. `~/.letta/agents`. */
  deniedRoots: string[];
  /** Paths to re-expose read-only (e.g. a subagent's parent memory dir). */
  readonlyRoots?: string[];
  /** Paths to re-expose read-write (self agent/memory dir, $TMPDIR, /tmp). */
  writableRoots?: string[];
  /** Memory mode: deny writes everywhere except `writableRoots`. */
  restrictWrites?: boolean;
}

/**
 * Assemble an {@link FsSandboxPolicy} from plain paths, normalizing and
 * de-duplicating each set. Pure — no filesystem or agent-context access.
 */
export function buildFsSandboxPolicy(
  options: BuildPolicyOptions,
): FsSandboxPolicy {
  return {
    deniedRoots: normalizeRoots(options.deniedRoots),
    readonlyRoots: normalizeRoots(options.readonlyRoots ?? []),
    writableRoots: normalizeRoots(options.writableRoots ?? []),
    restrictWrites: options.restrictWrites ?? false,
  };
}

/**
 * Normalize a path for use in a sandbox rule: absolute, forward slashes, no
 * trailing slash. Relative inputs are resolved against `/` so a malformed
 * policy can never silently scope a rule to the current working directory.
 */
export function normalizeSandboxPath(path: string): string {
  const trimmed = path.trim();
  const absolute = isAbsolute(trimmed) ? trimmed : resolve("/", trimmed);
  const forward = absolute.replace(/\\/g, "/");
  return forward.replace(/\/+$/, "") || "/";
}

function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root || !root.trim()) continue;
    seen.add(normalizeSandboxPath(root));
  }
  return [...seen];
}
