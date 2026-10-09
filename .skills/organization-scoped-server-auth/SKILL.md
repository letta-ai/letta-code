---
name: organization-scoped-server-auth
description: How `letta server --org <orgId>` device-code authentication works and the client-side invariants that keep it safe. Use when implementing, reviewing, or debugging Letta Code server authentication or listener credential handling.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-aff3835f-cd39-4e6f-becd-b793549e546a"]'
  rationale: 'letta server --org introduces non-obvious auth boundaries: org-scoped credentials live in a separate slot so the global sign-in is never read or overwritten, and the CLI forwards the org id verbatim while the Cloud server is the validator. Future server-auth or listener-credential work risks authorization errors without this knowledge, which no existing target artifact documents.'
---

# Organization-Scoped Server Authentication

Explains the org-scoped `letta server --org <orgId>` device-code auth flow and
the client-side rules that keep it safe. Apply these rules when implementing,
reviewing, or debugging `src/auth/*`, `src/cli/subcommands/server.ts`, listener
credential storage, or `letta server` / `letta listen` auth paths.

## How the flow works

The chain is: the dashboard Computers page prints `letta server --org <orgId>`
-> the user runs it -> the CLI sends `organization_id` verbatim in the
device-code request -> the Cloud consent page shows that org (no org switcher,
no project picker) -> the token is minted in that org. Without `--org`, behavior
is unchanged from the default device-code sign-in.

## Client invariants

- **Credential slot isolation is mandatory.** An org-scoped sign-in keeps its
  tokens in its own org-keyed credential slot (`listener-org-auth`) with its own
  `device_id`. The global `letta` sign-in must never be read from or overwritten
  as a side effect: the platform-org login is a different device id, and
  touching it lets Cloud revoke the global refresh token. Reconnects reuse the
  same org slot.
- **The CLI never resolves orgs.** It forwards the `--org` string verbatim; it
  does not look orgs up, pick defaults, or enumerate memberships. The server is
  the validator: unknown or empty org ids are rejected there (400 `Organization
  not found`). Do not add client-side org lookup or organization picking, and do
  not derive the org id client-side - it comes from the dashboard command, not
  from a CLI query.
- **`--org` conflicts with `--listen`** and is rejected together with it.
  Self-hosted servers error cleanly (unsupported).
- **The flag requires server support.** It only takes effect when the connected
  Cloud server honors `organization_id` on the device-code request; until then
  the request degrades to the default approval flow where the approver picks the
  org.

## Why this works / why it will be useful again

The org handoff is non-obvious: correctness and safety depend on boundaries that
span two repositories (CLI forwards, server validates) and on a credential slot
design whose violation silently breaks the user's global sign-in (refresh-token
revocation) or mints a token into the wrong org. These constraints were only
established during this feature's review, appear nowhere in AGENTS.md or the
existing skills, and are not reliably reconstructable from code reading alone.
Retaining them prevents future authorization regressions and re-deriving the
design from scratch.
