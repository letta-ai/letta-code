import type { FsSandboxPolicy } from "./policy.js";

/**
 * Linux bubblewrap backend.
 *
 * We shell out to `bwrap`, building a mount namespace that mirrors the same
 * policy model as Seatbelt:
 *
 *   - The root filesystem is bound `--ro-bind` (write-scoped profile,
 *     default-deny writes) or `--bind` (cross-agent profile, default-allow writes). This single
 *     choice implements `restrictWrites` for free: under a read-only root, the
 *     only writable paths are the explicit `--bind` carveouts.
 *   - Each denied root is masked with `--tmpfs`, so other agents' directories
 *     are not merely unwritable but *absent* — unreadable and unenumerable,
 *     strictly stronger than the static guard.
 *   - readonly / writable carveouts are re-bound on top. bwrap creates the
 *     mountpoints inside the tmpfs as needed, so a self-memory dir nested in a
 *     masked agents tree reappears.
 *
 * No `--unshare-net`: network stays open (out of scope for memory isolation).
 * `--die-with-parent` ensures the sandbox tears down with the agent process,
 * backing up the process-group kill in `shell-runner.ts`.
 *
 * Mount order matters — later operations layer over earlier ones: root → dev →
 * proc → base writable → mask denied → restore readonly → restore writable.
 * The base-writable binds come BEFORE the masks so a denied root nested inside a
 * broad base carve (the cross-agent tree under `~/.letta`) is still masked.
 */

/** Default discovery name; availability probing may substitute a bundled path. */
export const BWRAP_BIN = "bwrap";

/**
 * Build the bwrap flag list (everything between the binary and the `--`
 * separator). The caller prepends the bwrap path and appends
 * `"--"` + the inner launcher.
 */
export function buildBwrapArgs(policy: FsSandboxPolicy): string[] {
  const args: string[] = [];

  // Root view: read-only for write-scoped profiles, writable for cross-agent.
  args.push(policy.restrictWrites ? "--ro-bind" : "--bind", "/", "/");

  // Minimal writable /dev (gives us /dev/null, /dev/urandom, ptys) and a fresh
  // /proc so the masked root doesn't leak host process state.
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // Base writable roots: re-bind a broad harness dir (~/.letta) read-write on top
  // of the read-only root. Emitted BEFORE the masks below so a denied root nested
  // inside (the cross-agent tree) is still masked — the ancestor-carve hazard is
  // intentional and safe HERE precisely because the mask runs last. `-try` for
  // the same not-yet-created tolerance as the other carves.
  for (const root of policy.baseWritableRoots) {
    args.push("--bind-try", root, root);
  }

  // Mask each denied root with an empty tmpfs.
  //
  // HAZARD (ancestor carve-out): the restore binds below run *after* these
  // masks, and bwrap is last-mount-wins for overlapping paths. A carve-out must
  // therefore be a *descendant of* (or disjoint from) every denied root — never
  // an ancestor. An ancestor carve-out (e.g. binding `/tmp` writable when the
  // agents tree lives under `/tmp`) re-binds the whole subtree on top of the
  // mask and silently re-exposes the denied roots. Callers must not produce
  // such roots; this is why the memory-subagent profile scopes writes to memory
  // roots and does not carve a temp dir. (Seatbelt has no equivalent: it matches
  // most-specific deny rules, independent of order.)
  for (const root of policy.deniedRoots) {
    args.push("--tmpfs", root);
  }

  // Restore readonly/writable carveouts on top of the masks. Use the `-try`
  // variants: a carve-out root may not exist on disk yet — e.g. the
  // `memory-worktrees` sibling that `resolveAllowedMemoryRoots` always lists but
  // which is created lazily. Plain `--ro-bind`/`--bind` abort the *entire*
  // sandbox when the source is missing, so a not-yet-created root would fail the
  // spawn outright; `-try` skips a missing source (nothing to expose anyway, and
  // the denied-root masks above still hold). Seatbelt tolerates non-existent
  // paths natively, so this keeps the two backends behaviorally aligned.
  for (const root of policy.readonlyRoots) {
    args.push("--ro-bind-try", root, root);
  }

  for (const root of policy.writableRoots) {
    args.push("--bind-try", root, root);
  }

  args.push("--die-with-parent");
  return args;
}
