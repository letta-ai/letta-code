---
name: repository-checkout-bootstrap
description: >-
  Maps where managed-sandbox attached-repository (MemFS) checkouts are
  bootstrapped in letta-code and how snapshot- or seed-backed cold-start
  changes must be scoped. Use before changing repository checkout or clone
  behavior, adding snapshot/seed support, or debugging a fresh versus
  incremental repository mount.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-1547b95c-ed90-4a16-ad7e-451f74533a41"]'
  rationale: >-
    A managed-sandbox cold-start review (Daytona snapshots vs. Git bundles)
    assigned fresh attached-checkout behavior to letta-code but left the
    placement implicit. Pinning the single fresh-clone site and the
    unchanged incremental path prevents future seeding work from targeting
    the wrong branch or re-deriving the file locations from scratch.
---

# Repository Checkout Bootstrap

Attached (MemFS) repository mounts are cloned by letta-code's own harness
inside a managed sandbox. Cold-start seeds and snapshots are applied at the
sandbox level before letta-code runs; letta-code itself has no seed-download
path and needs none for the selected approach.

## Where fresh checkouts are cloned

- `syncRepoMount()` in `src/agent/memory-git.ts` is the only fresh-clone site
  for attached repositories: the `fresh` branch runs
  `git clone <remoteUrl> .`.
- It is wrapped by `withRepositoryCheckout()` in
  `src/utils/repository-checkout.ts`, which owns the checkout lock, staging
  directory, and atomic publish, and supplies the `fresh` flag.
- The existing (non-fresh) branch runs `git pull --ff-only`; that incremental
  sync path, plus push, credential/hook setup, and the primary/shared-memory
  repo flow, are deliberately separate and stay unchanged.

## Snapshot/seed scope

- Any future seeding of fresh checkouts belongs only in the `fresh` clone
  branch of `syncRepoMount()`. Do not modify the existing incremental-sync
  path and do not add a signed-URL or bundle-download path inside letta-code.
- The selected cold-start approach preloads Git repositories into Daytona
  cold snapshots at the sandbox level (scoped per organization and
  repository), so the harness just clones then increments normally.

## Why this works / why it will be useful again

The managed-sandbox checkout bootstrap is a deliberate fresh-clone versus
incremental-pull split, but neither `AGENTS.md` nor any existing skill records
where it lives or where a seed change is allowed. Without this note, a future
snapshot/seeding change risks touching the wrong branch or re-implementing
download machinery that was explicitly rejected in favor of sandbox-level
seeding, forcing a re-derivation of these exact call sites.
