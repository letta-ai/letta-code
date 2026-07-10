import type { FsSandboxPolicy } from "./policy.js";

/**
 * macOS Seatbelt backend.
 *
 * We shell out to `/usr/bin/sandbox-exec` with an inline SBPL profile (`-p`).
 * Concrete paths are passed as `-D` parameters and referenced in the profile as
 * `(param "NAME")`, so the profile text never needs SBPL string escaping and
 * paths with spaces / quotes are safe (we spawn argv directly, no shell).
 *
 * The profile is `(allow default)` plus targeted denies — deliberately narrower
 * than Codex's Chrome-derived `(deny default)` base. Our threat model is
 * filesystem scoping for memory isolation, not general untrusted-code
 * confinement, so allow-default keeps network, signals, ttys, and arbitrary dev
 * tools working untouched while the FS rules do the isolation. SBPL is
 * last-match-wins, which is why the deny/allow ordering below matters.
 */

/** Hardcoded path — never resolved via PATH, to defend against a planted
 * `sandbox-exec` earlier on PATH (same rationale as Codex). */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

interface SeatbeltDefine {
  name: string;
  value: string;
}

/**
 * Build the SBPL profile text plus the `-D NAME=value` defines it references.
 * Exposed for snapshot testing; `buildSeatbeltArgs` is what callers use.
 */
export function buildSeatbeltProfile(policy: FsSandboxPolicy): {
  profile: string;
  defines: SeatbeltDefine[];
} {
  const defines: SeatbeltDefine[] = [];
  const lines: string[] = ["(version 1)", "(allow default)"];

  // 1. Memory mode: deny all writes globally. Keep device writes (/dev/null,
  //    ttys, pipes) working — countless tools depend on them and they are
  //    irrelevant to filesystem isolation.
  if (policy.restrictWrites) {
    lines.push('(deny file-write* (subpath "/"))');
    lines.push('(allow file-write* (subpath "/dev"))');
  }

  // 2. Base writable roots: re-allow writes under a broad harness dir (~/.letta).
  //    Emitted AFTER the global write-deny but BEFORE the denied roots, so a
  //    cross-agent tree nested inside still gets walled off in step 3.
  policy.baseWritableRoots.forEach((root, i) => {
    const name = `BASEWRITABLE_${i}`;
    defines.push({ name, value: root });
    lines.push(`(allow file-write* (subpath (param "${name}")))`);
  });

  // 3. Wall off the denied roots entirely (read + write). Overrides the base
  //    writable above for the cross-agent subtree.
  policy.deniedRoots.forEach((root, i) => {
    const name = `DENIED_${i}`;
    defines.push({ name, value: root });
    lines.push(`(deny file-read* file-write* (subpath (param "${name}")))`);
    // Git linked worktrees may stat denied ancestor directories while resolving
    // an allowed worktree path. Re-allow metadata on the denied root itself so
    // path canonicalization can succeed without exposing directory contents or
    // file data from other agents.
    lines.push(`(allow file-read-metadata (literal (param "${name}")))`);
  });

  // 4. Restore writable roots (read + write). Emitted after every deny above so
  //    it wins — including for a self-memory dir nested inside a denied root.
  policy.writableRoots.forEach((root, i) => {
    const name = `WRITABLE_${i}`;
    defines.push({ name, value: root });
    lines.push(`(allow file-read* file-write* (subpath (param "${name}")))`);
  });

  // 5. Restore readonly roots (read only). Wins over the read-deny; the
  //    corresponding write-deny still stands, so these stay read-only.
  policy.readonlyRoots.forEach((root, i) => {
    const name = `READONLY_${i}`;
    defines.push({ name, value: root });
    lines.push(`(allow file-read* (subpath (param "${name}")))`);
  });

  return { profile: `${lines.join("\n")}\n`, defines };
}

/**
 * Build the argv tail for `sandbox-exec`: `["-p", <profile>, "-DNAME=value",
 * ...]`. The caller prepends {@link SANDBOX_EXEC_PATH} and appends
 * `"--"` + the inner launcher.
 */
export function buildSeatbeltArgs(policy: FsSandboxPolicy): string[] {
  const { profile, defines } = buildSeatbeltProfile(policy);
  const args = ["-p", profile];
  for (const { name, value } of defines) {
    args.push(`-D${name}=${value}`);
  }
  return args;
}
