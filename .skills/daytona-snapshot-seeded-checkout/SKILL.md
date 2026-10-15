---
name: daytona-snapshot-seeded-checkout
description: Change map for seeding fresh attached-repository checkouts in Letta Code from a local Git bundle baked into a Daytona snapshot. Use when implementing or reviewing snapshot-seeded managed-sandbox repository provisioning in letta-code, or when touching the syncRepoMount / withRepositoryCheckout clone path.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-7b7c8e88-646f-4581-99b3-cab1e1e03293"]'
  rationale: 'An investigation asked whether Daytona snapshots could replace a GCS clone cache for cross-sandbox repository reuse. The narrow letta-code code-path map — which branch of syncRepoMount changes, why a bundle at a fixed path must be used instead of a prepared checkout at the mount path, and the fallback/credential semantics — is non-obvious and would otherwise be re-derived during implementation.'
---

# Daytona snapshot-seeded checkouts

## Decision

Seed a **fresh** attached-repository clone with a local Git bundle baked into
the managed-sandbox Daytona snapshot, consumed as
`git clone --bundle-uri=file://<seed> <memfs-remote> <staging>`. Only the fresh
branch of the attached-repository sync changes; existing checkouts, primary
memory, pushes, and Dream Engine clones are untouched.

Do **not** pre-place a prepared checkout (with `.git`) at the per-agent mount
path. Mount paths are `~/.letta/agents/{agentId}/{repo}`
(`getRepositoryMountDir` in `src/agent/memory-git.ts`) and `agentId` differs per
conversation sandbox, so a snapshot cannot match it, and a seeded `.git` would
carry the embedded credential helper, hooks, `letta.agentId`, and any
conversation state into every sandbox cloned from the snapshot.

## Where the change goes

- `src/agent/memory-git.ts` — `syncRepoMount()` (approx. line 329): the `fresh`
  branch currently runs `git clone <remoteUrl> .` inside `withRepositoryCheckout`.
  Change only this branch to look up a seed bundle under an env-named directory
  (harness sets it; letta-code has no existing managed-sandbox flag), e.g.
  `LETTA_REPOSITORY_SEED_BUNDLES_DIR` plus `<validated-name>.bundle`, and pass
  `--bundle-uri=file://<seed>` when present and git supports it, else plain
  clone. `prepareAttachedRepositoryForGitOps()` and
  `installSharedMemoryPreCommitHook()` already run after every clone, so
  per-sandbox credentials/config/hooks are applied over the seeded checkout as
  today.
- `src/utils/repository-checkout.ts` — `withRepositoryCheckout()`: unchanged. It
  locks `${directory}.checkout.lock`, clones into a staging dir, and publishes
  atomically on success (removing staging on failure), so a failed seed never
  publishes a broken checkout.
- `src/agent/memory-git.ts` — `buildGitAuthArgs()` (approx. line 483) sets a
  global `http.extraHeader` carrying the Letta token. With a `file://` bundle
  that header only reaches the memfs remote fetch; the local bundle needs no
  auth, so no credential is sent to the seed. Do not pull the seed through git
  over HTTP unless auth can be scoped to the remote only (this is the one
  hazard that made the superseded GCS signed-URL design require care).

## Constraints that must hold

- Pierre/memfs stays authoritative: the clone still contacts origin and fetches
  everything missing; the bundle only accelerates object population. A stale
  bundle still ends on the remote HEAD, and a missing or corrupt bundle falls
  back to a normal clone automatically (verified with git 2.39.5). A failed
  seed must still never replace an existing checkout.
- Independent writable: publish to the per-agent path only; never share `.git`
  or object stores between conversations. `--reference`/`--shared` are not
  acceptable without `--dissociate`.
- The seed must be built from a clean builder: committed objects + refs only;
  no working tree, hooks, git config, credentials, or uncommitted changes.
- Feature-detect `git clone --bundle-uri` (git >= 2.38) before enabling; older
  git errors on the unknown option rather than falling back, so unsupported
  clients must clone normally.

## Cloud-side vs letta-code

Cloud-side (snapshot provisioning, not this target) owns generating/refreshing
clean per-repo seed bundles at a fixed path in the snapshot, rebuilding on
meaningful repo change, and any per-org scoping. letta-code only consumes a
local bundle — no new endpoint, bucket, or signed URL is needed (the
simplification over the GCS design). Seeds age between snapshot (letta-code
release) builds; the remote fetch absorbs the delta, so seeding must not assume
a fresh seed.

## Focused tests

- Stale seed -> seeded clone reaches remote HEAD, not the bundle tip.
- Missing or corrupt seed -> normal clone; no broken checkout published; an
  existing checkout is never replaced.
- No auth header is sent to the seed; existing remote auth and cross-org/agent
  authorization are unchanged.
- Post-seed `pull --ff-only` fetches newly pushed commits; branches/tags
  reconcile against origin.
- Concurrent/repeated sandbox creation seeds from the same bundle to
  independent writable checkouts at the same remote revision.
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
