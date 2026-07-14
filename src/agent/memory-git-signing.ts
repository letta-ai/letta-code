/**
 * Memory-repo commits must never be signed.
 *
 * Operators with a global `commit.gpgsign=true` have no signing key for the
 * harness-managed committer identities (`<agentId>@letta.com`,
 * `noreply@letta.com`), so any signing attempt fails with
 * "gpg: signing failed: No secret key" and blocks memory init/commits,
 * reflection merges, and `pull --rebase` recovery.
 *
 * Passed as highest-precedence `-c` config on every harness git invocation
 * so it also covers commits git creates internally (rebase, merge).
 */
export const GIT_DISABLE_COMMIT_SIGNING_ARGS = [
  "-c",
  "commit.gpgsign=false",
] as const;
