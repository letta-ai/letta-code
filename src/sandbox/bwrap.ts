import type { FsSandboxPolicy } from "./policy.js";

/**
 * Linux bubblewrap backend.
 *
 * We shell out to `bwrap`, building a mount namespace that mirrors the same
 * policy model as Seatbelt:
 *
 *   - The root filesystem is bound `--ro-bind` (memory mode, default-deny
 *     writes) or `--bind` (cross-agent mode, default-allow writes). This single
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
 * proc → mask denied → restore readonly → restore writable.
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

  // Root view: read-only for memory mode, writable for cross-agent mode.
  args.push(policy.restrictWrites ? "--ro-bind" : "--bind", "/", "/");

  // Minimal writable /dev (gives us /dev/null, /dev/urandom, ptys) and a fresh
  // /proc so the masked root doesn't leak host process state.
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // Mask each denied root with an empty tmpfs.
  for (const root of policy.deniedRoots) {
    args.push("--tmpfs", root);
  }

  // Restore readonly carveouts (e.g. parent memory for a subagent).
  for (const root of policy.readonlyRoots) {
    args.push("--ro-bind", root, root);
  }

  // Restore writable carveouts (self memory/agent dir, $TMPDIR, /tmp).
  for (const root of policy.writableRoots) {
    args.push("--bind", root, root);
  }

  args.push("--die-with-parent");
  return args;
}
