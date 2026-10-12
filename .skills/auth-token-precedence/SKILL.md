---
name: auth-token-precedence
description: Explains how Letta Code resolves the Letta API credential that every HTTP, turn, memfs, and shell-tool consumer uses, and how to run any letta-code process (including `letta server`) as a specific organization. Use when a process must authenticate as a particular org, when debugging which credential a request used, or before adding new auth/credential-scoping code.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-aff3835f-cd39-4e6f-becd-b793549e546a"]'
  rationale: 'A PR review (PR #5004) established that every credential consumer shares one token precedence and that in-process per-org credential slots were rejected. A future agent needing to run or inspect letta-code as a specific org would otherwise re-derive this from scattered files across the repo.'
---

# Auth Token Precedence

Every Letta Code credential consumer resolves the API key with the same
precedence:

```
getDesktopAccessToken() || process.env.LETTA_API_KEY || settings.env.LETTA_API_KEY
```

- `getDesktopAccessToken()` (in `src/auth/desktop-credentials.ts`) is only set
  when running through the Electron desktop flow.
- `process.env.LETTA_API_KEY` overrides the stored sign-in.
- `settings.env.LETTA_API_KEY` is the value written by `letta login` /
  `letta server`, backed by the secure keychain.

The same precedence is read by agent turns (`getClient` in
`src/backend/api/client.ts`), REST requests (`src/backend/api/request.ts`),
shell-tool env injection (`src/tools/impl/shell-env.ts`), memfs
(`src/agent/memory-auth.ts`), subagent inheritance, secret redaction, and
memory-git. So a value set at `process.env` reaches every consumer, and the
stored sign-in can never silently override an env key.

## Running as a specific organization

There is no per-org CLI flag (`letta server --org` was proposed but rejected;
PR #5004 was closed without merging). `letta server`'s device-code sign-in
registers the computer under the resolving token, i.e. the org of the active
login.

To make any letta-code process act as a specific org - including registering a
computer into an org the machine's normal sign-in would not pick - mint an API
key in the target org and prefix the command with `LETTA_API_KEY=...`. Because
the env override wins everywhere, socket registration, turns, memfs, and shell
tool auth all agree.

Keep one login per process: do not add in-process per-org credential slots to
let one process span orgs. That was the rejected design behind PR #5004. Use an
env-scoped key (one identity per process) or a separate settings profile.

## Key lifetime

A stored sign-in refreshes in place via `getClient` watching
`tokenExpiresAt`. An env var value is used verbatim and is never refreshed: put
a non-expiring key (API key) in env, not a short-lived OAuth/access token, or
requests will start failing after expiry even while the socket looks healthy.

## Why this works / why it will be useful again

The precedence is a stable property of the auth layer, not behavior of any one
feature: it took multi-file tracing to confirm that a process-wide override
covers every consumer, and this cost recurs every time someone needs to run
letta-code as a non-default identity or verify which credential a request used.
Recording the single resolution rule, the one rejected per-org design, and the
env-key refresh caveat removes the need to re-trace `client.ts`, `request.ts`,
`shell-env.ts`, and peers again.
