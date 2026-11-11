---
name: monitor-url-capture
description: Decides when Letta Code Monitor calls should use the Cloud `url` source instead of command/script/ws, and which Monitor extensions would capture the most currently-unserved cases. Use when adding or reviewing anything about the Monitor tool in letta-code, or when a monitored workflow polls an HTTP endpoint.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-302e74fc-4a06-435e-9d04-0cebacfe945c"]'
  rationale: 'The trajectory implemented the Cloud URL monitor across letta-cloud and letta-code, then audited real Monitor calls to find which fit it and which extensions would capture more. Those fit boundaries and capture-gap priorities are letta-code-specific guidance that would otherwise be re-derived from scratch or silently over-promised.'
---

# Monitor `url`-source capture guidance

## When the Cloud `url` source fits

Use `Monitor({ url, interval_seconds, timeout_ms })` only when every condition holds:

- The watch is "notify me when a **public** HTTP(S) **GET** resource's status or body changes."
- The URL is publicly reachable from Letta Cloud. Private, loopback, internal, and sandbox-local addresses are rejected; GET-only, no headers, auth, method, or body.
- A condition that already holds may notify late or never: the first poll only establishes a baseline, so an already-completed/failed job does not produce an immediate event.
- The watch must outlive the sandbox: `url` monitors run in Cloud and keep polling when the sandbox stops. Requires a Cloud connection.

Otherwise keep `command`, `script`, or `ws` (or Wake/cron plus shorter monitors) for: authenticated APIs; matching a specific field or terminal state; acting on an already-met state now; POST/GraphQL requests; local/private endpoints; new-message streams with cursors.

## Current parameters

`url` (required), `description` (label only — it does not configure what to watch), `interval_seconds` (int, min/default 60), `timeout_ms` (default 24h, max 7 days). Mutually exclusive with `command`/`ws`/`script`; cancel with `TaskStop`. Monitors cannot be created against the agent's default conversation.

## Extensions that capture the most (not yet implemented)

An audit of sampled Monitor calls with HTTP/GitHub shapes found the dominant real use is authenticated CI/Git state polling (GitHub CLI plus private CI APIs), nearly all requiring credentials, ahead of watching one field until a terminal state. Priority for extending the tool:

1. Authentication through secret/connection references — never raw credentials in Temporal history.
2. Field selection + notify conditions + stop-on-match, including first-poll evaluation so already-complete jobs notify immediately.
3. Default-conversation support — currently rejected on the client, excluding a meaningful portion of candidate calls.

Repository, pipeline, and branch filters belong in the URL/query string, not new parameters. POST/GraphQL bodies and message cursors are separate later extensions; do not treat basic URL watching as covering them.

## Why this works / why it will be useful again

The shipped `url` source (letta-code #5635) is deliberately narrow, yet most real Monitor calls are authenticated CI-state polls or field/condition watches it cannot express. Encoding the fit boundaries and the ranked capture gaps in letta-code means tool changes and Monitor PR reviews start from measured priorities instead of re-running the analysis or over-promising what `url` covers.
