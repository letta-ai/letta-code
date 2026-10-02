---
name: first-run-onboarding
description: Guidance for implementing, testing, and reviewing the first-run onboarding flow of `letta server` — the welcome banner, computer-name registration, and device-auth browser open. Use when changing or verifying first-run state persistence, the welcome banner, or the device-auth flow.
---

# First-Run Onboarding

## How the flow gates

The first-run flow is per-directory and per-HOME, not per-account. Two independent gates:

1. **Welcome banner + computer-name registration** fires when the cwd's
   `.letta/settings.local.json` has no saved listener env name
   (`settingsManager.getListenerEnvName()`). The first run writes the name
   (`setListenerEnvName`), so later runs in the same directory skip the banner.
2. **Device auth + browser open** fires when there is no `LETTA_API_KEY` env
   and no saved token in `$HOME/.letta/settings.json`. Reconnect paths pass
   `allowInteractiveOAuth: false` and must never open a browser.

## Test a full first run deterministically

Reset both gates and run in one paste:

```bash
rm -rf /tmp/fresh /tmp/freshcwd && mkdir -p /tmp/fresh /tmp/freshcwd && cd /tmp/freshcwd && env -u LETTA_API_KEY HOME=/tmp/fresh node letta.js server
```

Deleting the cwd resets the banner gate; a fresh `HOME` resets the auth gate.

## Render static output directly, not with Ink

Static fire-and-forget output (the welcome banner) is written directly with
chalk/console.log, not mounted through Ink: Ink emits cursor/erase control bytes
when stdout is redirected, and its output is batched to the next tick, so
unmounting without a user event needs a timing guess. Chalk's own detection
ignores `NO_COLOR`; honor it explicitly (`new Chalk({ level: 0 })` when
`NO_COLOR` is set and non-empty). The logo is background-color cells, so drop it
at color level 0.

## Verify the terminal matrix once

Before pushing render-sensitive output, exercise the full matrix in one pass:
truecolor TTY, 256-color TTY (e.g. Terminal.app), redirected stdout, `NO_COLOR`,
and `FORCE_COLOR`. Iterating one axis per review round is how banner regressions
slipped through.

## Registration invariants

- Default computer name is `hostname() || "my-computer"`; keep the fallback so
  an empty hostname cannot produce an empty connection name.
- `--computer-name` overrides the default and is saved to the cwd's local
  settings.
- Device auth prints the URL and code before a best-effort browser open; the
  open must never be required (it fails silently on headless/SSH machines).
