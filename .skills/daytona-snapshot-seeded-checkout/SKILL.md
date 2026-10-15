---
name: daytona-snapshot-seeded-checkout
description: Change map for seeding fresh attached-repository checkouts in Letta Code from a local Git bundle exposed at a fixed path by a Daytona snapshot. Use when implementing or reviewing snapshot-seeded managed-sandbox repository provisioning in letta-code, or when touching the syncRepoMount / withRepositoryCheckout clone path.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-7b7c8e88-646f-4581-99b3-cab1e1e03293"]'
  rationale: 'An investigation asked whether Daytona snapshots could replace a GCS clone cache for cross-sandbox repository reuse. The narrow letta-code code-path map — which branch of syncRepoMount changes, why a bundle at a fixed path must be used instead of a prepared checkout at the mount path, and the fallback/credential semantics — is non-obvious and would otherwise be re-derived during implementation.'
---

# Daytona snapshot-seeded checkouts

## Decision

Seed only a **fresh** attached-repository clone with a self-contained Git
bundle that the managed-sandbox Daytona snapshot exposes at a fixed path,
consumed as `git clone --bundle-uri=file://<seed> <memfs-remote> <staging>`
inside `withRepositoryCheckout`. Only the fresh branch of the
attached-repository sync changes; existing checkouts, primary memory, pushes,
and Dream Engine clones are untouched.

Coverage is best-effort and never assumed: the cloud selects per-repository
snapshots, so a sandbox may carry seed bundles for zero, one, or several of its
attached repositories. Whenever a needed bundle is absent, unsupported, or
unusable, the harness runs the existing plain clone — the seed is an
optimization, never a dependency.

Do **not** pre-place a prepared checkout (a working tree with `.git`) at the
per-agent mount path `~/.letta/agents/{agentId}/{repo}` (`getRepositoryMountDir`,
`src/agent/memory-git.ts:246`). `agentId` is conversation-scoped and unknown at
snapshot-build time, so an immutable snapshot cannot match it, and a seeded
`.git` would carry the builder's local config, credential helper, hooks,
`letta.agentId`, and any conversation state into every sandbox derived from the
snapshot. A clean bundle — committed objects and refs only — removes that entire
hazard class; a prepared checkout is therefore never the consumer contract.

## Where the change goes

- `src/agent/memory-git.ts` — `syncRepoMount()` (`:329`): the `fresh` branch
  today runs `git clone <remoteUrl> .` inside `withRepositoryCheckout`. Change
  only this branch: resolve a seed as `<dir>/<validatedName>.bundle` under an
  env-named directory, e.g. `LETTA_REPOSITORY_SEED_BUNDLES_DIR`, where
  `validatedName` follows the existing `validateAgentRepositoryName` charset
  (`[A-Za-z0-9._-]{1,64}`) so no path traversal is possible; when the file
  exists and git supports `--bundle-uri`, pass `--bundle-uri=file://<seed>`,
  else clone normally. `prepareAttachedRepositoryForGitOps()` (`:317`) and
  `installSharedMemoryPreCommitHook()` already run after every clone
  (`syncRepoMount` `:353`–`354`), so per-sandbox credentials/config/hooks are
  applied over the seeded checkout as today. The existing opt-in env precedent
  for harness behavior is `LETTA_MEMFS_BACKEND=hosted`; `LETTA_MANAGED_CLOUD_RUNTIME`
  is a runtime marker set from listener identity and `LETTA_FS_SANDBOX` gates
  subagent filesystem sandboxing — none is a managed-sandbox provisioning flag.
- `src/utils/repository-checkout.ts` — `withRepositoryCheckout()` (`:7`):
  unchanged. It locks `${directory}.checkout.lock`, clones into a staging dir,
  and publishes atomically by rename (removing staging on failure), so a failed
  seed never publishes a broken checkout.
- `src/agent/memory-git.ts` — `buildGitAuthArgs()` (`:483`) sets a global
  `http.extraHeader` carrying the Letta token. Git sends that header only on
  http(s) remotes, so with a `file://` seed it reaches only the memfs remote
  fetch and no credential goes to the seed (verified). Do not pull the seed
  through git over HTTP unless auth can be scoped to the remote only.

## Constraints that must hold

- Pierre/memfs stays authoritative: the clone still contacts origin and fetches
  whatever the bundle lacks; the bundle only accelerates object population.
  Verified on git 2.39.5: a stale seed still ends on the remote HEAD with
  bundled objects reused; a missing seed and a corrupt/non-bundle file both
  make git warn and fall back to a normal clone with exit 0. A failed seed
  never replaces an existing checkout, because only `withRepositoryCheckout`
  publishes and only after a fresh clone succeeds.
- Independent writable: publish to the per-agent path only; never share `.git`
  or object stores between conversations. The bundle is self-contained (objects
  are imported into each clone's own object store), so `--reference`/`--shared`
  coupling does not arise — do not introduce them.
- The seed must be built from a clean builder: committed objects + refs only;
  no working tree, hooks, git config, credentials, or uncommitted changes.
- Feature-detect `git clone --bundle-uri` (added in git 2.38.0; verified on
  2.39.5) before enabling; older git errors on the unknown option rather than
  falling back, so unsupported clients must clone normally.

## Cloud-side vs letta-code

Cloud-side (snapshot provisioning, a letta-cloud concern, not this target) owns
creating and refreshing per-repository cold snapshots whose filesystem carries a
clean fixed-path bundle for that repo, rebuilding on meaningful repo change, and
per-org scoping of snapshot selection. letta-code only consumes local bundle
files — no new endpoint, bucket, or signed URL is needed (the simplification
over the GCS design). Seeds age between per-repository snapshot refreshes on the
cloud side, not between letta-code release builds; the remote fetch absorbs the
delta, so seeding must not assume a fresh or present seed. If a future cloud
form ever placed a prepared checkout in the snapshot instead of a bundle, the
harness must still ignore it and clone from the remote — the fixed-path bundle
is the required consumer contract.

## Focused tests

(Add alongside `src/utils/repository-checkout.test.ts`, which already covers
atomic publication, failed-setup non-publication, and serialized concurrent
publishers.)

- Stale seed -> seeded clone reaches remote HEAD, not the bundle tip; bundled
  objects are reused, not re-downloaded.
- Missing or corrupt seed -> normal clone; no broken checkout published; an
  existing checkout is never replaced.
- No auth header is sent to the seed; existing remote auth and cross-org/agent
  authorization are unchanged.
- Post-seed `pull --ff-only` fetches newly pushed commits; branches/tags
  reconcile against origin.
- Concurrent/repeated sandbox creation seeds from the same bundle to
  independent writable checkouts at the same remote revision.
- A bundle present for a repo not attached to this agent is ignored (name lookup
  is exact and validated).
- Git without `--bundle-uri` support clones normally.

## Why this works / why it will be useful again

The investigation behind this change map (trajectory
`letta:conv-7b7c8e88-646f-4581-99b3-cab1e1e03293`) wanted to cut repeated
full-size Git transfers caused by fresh conversation-scoped sandboxes cloning
the attached living-library repositories from scratch. Daytona snapshots can
carry those repository objects locally, but the harness must consume them
without violating the constraints the superseded GCS design relied on:
independently writable per-conversation checkouts, a remote that stays
authoritative and still fetches deltas, ordinary-clone fallback when the seed
is unusable, and no credential or per-conversation state leakage.
`git clone --bundle-uri=file://...` satisfies all of these with a single
fresh-branch change, and its corrupt/missing-bundle fallback is inherent to
git. What is non-obvious and worth keeping is the code-path map above — which
function and branch changes, why a bundle at a fixed path instead of a prepared
checkout at the mount path, and the auth-header hazard — without which
implementing or revisiting this feature would require re-tracing
`syncRepoMount`, `withRepositoryCheckout`, `buildGitAuthArgs`, and the
per-agent mount-path layout again.
