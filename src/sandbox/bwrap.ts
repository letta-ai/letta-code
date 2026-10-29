import { type FsSandboxPolicy, getOrderedSandboxPathRules } from "./policy.js";

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
 * proc → base writable → broad-to-narrow deny/self rules.
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

  // Apply deny and self-carve rules from broadest path to narrowest path. This
  // supports alternating overlap shapes (deny → outer self → nested deny →
  // inner self) without erasing a legitimate inner carve. Use `-try` binds so a
  // lazily-created memory root does not abort the entire spawn.
  for (const rule of getOrderedSandboxPathRules(policy)) {
    switch (rule.kind) {
      case "deny":
        args.push("--tmpfs", rule.root);
        break;
      case "readonly":
        args.push("--ro-bind-try", rule.root, rule.root);
        break;
      case "writable":
        args.push("--bind-try", rule.root, rule.root);
        break;
    }
  }

  args.push("--die-with-parent");
  return args;
}
