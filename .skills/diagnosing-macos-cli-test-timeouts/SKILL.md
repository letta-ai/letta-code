---
name: diagnosing-macos-cli-test-timeouts
description: Diagnoses macOS CI timeouts on Letta Code CLI command tests such as `usage --help`. Use when a macOS CI run fails a CLI test around the 15s mark, when triaging a recurring macOS usage/help timeout during the CI-repair pass, or before deciding whether a CLI-test timeout is a product regression or cold-start latency.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-5fdc59d8-8919-4904-8479-90e92250ffe4"]'
  rationale: 'The daily CI repair pass repeatedly hit a macOS usage-help 15s timeout that turned out to be cold-start import latency, not a product defect. Keeping the signature and its fix pattern prevents a future agent from re-deriving the diagnosis or opening a duplicate repair.'
---

# Diagnosing macOS CLI Test Timeouts

On macOS CI runners, Letta Code's pre-main imports take about 14.4s before a
CLI command runs; the help output itself renders in ~13ms. A CLI command test
with a 15s timeout (e.g. `usage --help` in `src/cli/subcommands/usage.test.ts`)
is therefore marginal on cold macOS runners and can intermittently time out.

## Triage

- Before treating the timeout as a product regression or opening a repair,
  confirm current main passes the same test. Current main passed at ~14.4s in
  the recorded run, so old-head 15s failures were explained by cold-start
  import latency.
- If a timeout recurs on older heads or other PRs while current main passes,
  do not open a duplicate repair; check whether an existing repair already
  bumps that one test's timeout.

## Repair pattern

The accepted fix is a test-only timeout bump for the affected test (e.g. to
30s), never a production change, weakened assertion, or skipped check.

## Why this works / why it will be useful again

Cold-start import latency on macOS is a stable property of this repo's CLI
entry path, so the same marginal-timeout signature can reappear on new heads.
Knowing the diagnosis short-circuits a full reproduction cycle and avoids
duplicate repair PRs.
