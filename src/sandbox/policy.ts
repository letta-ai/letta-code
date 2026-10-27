import { posix, win32 } from "node:path";

/**
 * A filesystem sandbox policy, expressed entirely in concrete absolute paths.
 *
 * This module is a pure leaf: it knows nothing about agents, launch profiles, or
 * how paths are derived. Callers resolve agent ids / memory roots into paths
 * (via `@/permissions/memory-paths`) and hand the finished policy here. That
 * keeps the OS-specific generators (`seatbelt.ts`, `bwrap.ts`) trivially
 * testable and out of the domain layer graph.
 *
 * Enforcement semantics (both backends implement the same model):
 *
 *   - `baseWritableRoots`  write re-allowed under these, emitted BEFORE
 *                       `deniedRoots` so a denied root nested inside still wins.
 *                       Used to grant a broad harness dir (e.g. all of
 *                       `~/.letta`) while keeping the cross-agent tree denied —
 *                       so a memory subagent may write harness state anywhere
 *                       under `~/.letta` but not the repo/home/temp.
 *   - `deniedRoots`     read + write denied (e.g. `~/.letta/agents`).
 *   - `readonlyRoots`   read re-allowed, write stays denied. Overrides denied.
 *   - `writableRoots`   read + write re-allowed. Overrides denied, the global
 *                       write-deny, AND `baseWritableRoots` — for a self carve
 *                       nested inside a denied root (self memory).
 *   - `restrictWrites`  when true, writes are denied *everywhere* except
 *                       `baseWritableRoots`/`writableRoots` (write-scoped profile). When
 *                       false, writes are allowed by default except under
 *                       `deniedRoots` (cross-agent profile — the normal agent that
 *                       simply may not touch other agents' memory).
 *
 * Reads are never globally restricted: an agent can read the whole filesystem
 * to do its work, minus the other-agent directories in `deniedRoots`.
 *
 * Specificity is expressed through ordering, not nesting depth. The emitted
 * order is: global write-deny → `baseWritableRoots` → the remaining denied and
 * self-carve rules from broadest path to narrowest path. This permits the
 * required deny → outer self → nested deny → inner self alternation while
 * keeping the most specific path authoritative.
 */
export interface FsSandboxPolicy {
  baseWritableRoots: string[];
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
  /**
   * Broad write carves emitted BEFORE `deniedRoots` (a nested deny still wins).
   * e.g. all of `~/.letta` so a memory subagent can write harness state but not
   * the repo/home/temp.
   */
  baseWritableRoots?: string[];
  /** Roots to wall off (read+write), e.g. `~/.letta/agents`. */
  deniedRoots?: string[];
  /** Paths to re-expose read-only (e.g. a subagent's parent memory dir). */
  readonlyRoots?: string[];
  /** Paths to re-expose read-write (self agent/memory dir, $TMPDIR, /tmp). */
  writableRoots?: string[];
  /** Memory mode: deny writes everywhere except the writable roots. */
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
    baseWritableRoots: normalizeRoots(options.baseWritableRoots ?? []),
    deniedRoots: normalizeRoots(options.deniedRoots ?? []),
    readonlyRoots: normalizeRoots(options.readonlyRoots ?? []),
    writableRoots: normalizeRoots(options.writableRoots ?? []),
    restrictWrites: options.restrictWrites ?? false,
  };
}

export type SandboxPathRuleKind = "deny" | "readonly" | "writable";

export interface SandboxPathRule {
  kind: SandboxPathRuleKind;
  root: string;
  /** Index in the corresponding policy array, used for stable backend names. */
  index: number;
}

/**
 * Compile deny/self-carve rules in broad-to-narrow path order.
 *
 * Both sandbox backends use last-rule/mount-wins semantics. Sorting by depth
 * supports alternating overlap shapes such as primary deny → outer self carve
 * → nested backend deny → inner backend self carve. For an exact same path,
 * deny sorts last and therefore fails closed.
 */
export function getOrderedSandboxPathRules(
  policy: FsSandboxPolicy,
): SandboxPathRule[] {
  const rules: Array<SandboxPathRule & { order: number }> = [];
  let order = 0;
  const append = (kind: SandboxPathRuleKind, roots: string[]) => {
    roots.forEach((root, index) => {
      rules.push({ kind, root, index, order: order++ });
    });
  };

  append("deny", policy.deniedRoots);
  append("readonly", policy.readonlyRoots);
  append("writable", policy.writableRoots);

  const samePathPriority: Record<SandboxPathRuleKind, number> = {
    readonly: 0,
    writable: 1,
    deny: 2,
  };
  const depth = (root: string) => root.split("/").filter(Boolean).length;

  return rules
    .sort((a, b) => {
      const depthDifference = depth(a.root) - depth(b.root);
      if (depthDifference !== 0) return depthDifference;
      if (a.root === b.root) {
        return samePathPriority[a.kind] - samePathPriority[b.kind];
      }
      return a.order - b.order;
    })
    .map(({ kind, root, index }) => ({ kind, root, index }));
}

/**
 * Normalize a path for use in a sandbox rule: absolute, forward slashes, no
 * trailing slash. Relative inputs are resolved against `/` so a malformed
 * policy can never silently scope a rule to the current working directory.
 */
export function normalizeSandboxPath(path: string): string {
  const trimmed = path.trim();
  const absolute =
    posix.isAbsolute(trimmed) || win32.isAbsolute(trimmed)
      ? trimmed
      : posix.resolve("/", trimmed);
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
