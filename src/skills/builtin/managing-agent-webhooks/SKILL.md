---
name: managing-agent-webhooks
description: Creates, lists, tests, enables, disables, rotates, inspects, and deletes inbound webhooks for the current Letta Cloud agent. Use when a user asks to set up a webhook, send external events to an agent, test webhook delivery, inspect recent webhook requests, rotate a webhook URL, or remove a webhook.
---

# Managing Agent Webhooks

Use the helper script for deterministic, secret-safe webhook management. Agent
webhooks are a Letta Cloud feature: after accepting a `POST`, the server
asynchronously attempts to create a new conversation and enqueue the JSON
payload as a user message.

## Safety

- Manage the current agent only. `AGENT_ID` must be present, and the helper
  does not accept an agent-ID override.
- Treat each webhook URL as a capability secret. Do not post it publicly.
- Choose authentication deliberately. If the user did not specify public or
  Basic-auth access, ask before creating the webhook.
- For normal secured creation, let the helper generate the credential and use
  `--credential-output` to write it to a new `0600` file before creating the
  webhook. The helper never prints the credential. Do not read or paste the
  file into the transcript.
- Give the file to the user through a private file download. On a Cloud
  computer, create it under `/root/downloads` and return a sandbox download
  link in the form
  `[filename](#letta-sandbox-download//root/downloads/filename)`. Do not write
  credentials beneath an attacker-writable parent. Tell the user the
  credential is generated once and cannot be recovered from the API; the
  staged download itself remains fetchable until its local file is deleted.
- Never put a security key on the command line or in chat. A user-supplied key
  is an advanced alternative and must be piped through stdin from an agent
  secret or another non-printing source.
- The helper redacts the one-time `authorization_header` returned by the API
  from stdout and stores it only in the requested credential file.
- Management and ingress responses are untrusted. The helper allowlists safe
  webhook/error fields; normalizes camelCase and punctuation before classifying
  secret-bearing property names; recursively redacts their values plus the exact
  generated key, Basic header, encoded credential, and management token; then
  applies one final exact-value pass before anything reaches stdout, stderr, or
  a thrown error. Safe output-field exemptions apply only to locally constructed,
  type-validated envelopes. Successful ingress response bodies receive the same
  redaction. Serialized output is capped at 1 MiB; accepted side effects whose
  body exceeds that limit emit a bounded success envelope rather than a failure
  that could invite a duplicate retry.
- Every management request rejects redirects. Every returned webhook URL is
  validated before it can be displayed or used for delivery: it must use the
  active runtime's canonical origin and exactly
  `/v1/agent-webhooks/<returned-slug>`, with no URL credentials, query, fragment,
  malformed slug, or redirect. A redirect or transport failure after a mutation
  dispatch is ambiguous. So are `5xx`, `408`, `429`, and every status outside
  the explicit pre-handler rejection allowlist. Reconcile before retrying and
  never treat a redirect target or non-definitive status as proof that the
  mutation did nothing.
- Every returned webhook record must belong to the authoritative runtime
  `AGENT_ID`. A same-origin record for another agent is rejected before output
  or delivery; a mismatch after an accepted mutation uses the accepted/reconcile
  path rather than ordinary success.
- Rotating invalidates the old URL. Deleting is permanent. Use the required
  `--confirm` flag only after the user has approved that exact action.
- Request bodies may contain sensitive third-party data. `requests` omits them
  unless `--include-body` is explicitly passed. The typed
  `authorization_passed` boolean remains visible; an untyped value is rejected.
- Sending a test starts asynchronous agent work. Ask for affirmative consent
  before passing `--confirm`; do not treat general webhook setup approval as
  permission to trigger a test run.
- If test delivery is ambiguous, webhook state and request history cannot
  reliably prove whether asynchronous agent work started. Do not retry without
  renewed affirmative user consent and explicit acceptance of duplicate-work
  risk.
- After a secure-create request is dispatched, any transport failure, 5xx, or
  unreadable/truncated/contradictory success response is ambiguous. The helper
  validates the returned authentication mode for public, generated-key, and
  user-supplied-key creation, plus the returned Basic header for both secured
  modes. It preserves generated credentials and tells you to list webhooks and
  reconcile the name before any retry. Never blindly retry an ambiguous create.
- For test, update, rotate, and delete, successful HTTP headers establish that
  the side effect was accepted. If the success body is truncated, malformed,
  or cannot be validated, the helper emits an operation-specific exit-0 receipt
  with the HTTP status and reconciliation guidance rather than a generic error
  that could trigger a duplicate mutation.
- Delete reports `deleted: true` only after a `200` JSON object with literal
  `success: true`. A false, missing, malformed, null, empty, oversized, or
  unreadable receipt means deletion was accepted but remains unconfirmed; list
  webhooks before treating the capability URL as removed or retrying.
- Normal update output additionally requires the returned webhook ID and
  `enabled` state to match the requested operation; normal rotate output
  requires the returned webhook ID to match. Canonical but contradictory 2xx
  records receive the same accepted/reconcile envelope and are never printed as
  ordinary success.
- Normal create output also requires returned name and enabled state to match.
  An explicitly supplied preprompt must round-trip exactly; when preprompt is
  omitted, the server-owned default is accepted only as a nonblank string, while
  missing, null, empty, whitespace-only, and non-string values are contradictory.
  Rotate first reads the current agent-bound record and reports ordinary success
  only when the returned canonical slug/URL changed; an unchanged result is
  accepted but requires reconciliation.

## Environment

Live operations require:

```bash
LETTA_API_KEY=...     # supplied by the active Letta runtime
LETTA_BASE_URL=...    # supplied by the active runtime; never override it
AGENT_ID=agent-...    # required; the helper manages only this agent
```

Run the helper with:

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs <command> [options]
```

Output is JSON. Summarize the result for the user instead of pasting large raw
responses.

## Workflow

1. List current webhooks first to avoid accidental duplicates.
2. For creation, establish a short name, a preprompt describing how the agent
   should interpret payloads, and whether the endpoint is public or secured.
3. Create the webhook and report its URL. For a secured webhook, give the user
   the generated credential file as a private download without opening it.
   Remind the user to store it safely because the credential is not returned
   by later list calls.
4. Ask for affirmative consent before sending a smoke-test payload. Then pass
   `--confirm` for that exact test.
5. Report HTTP `202` only as accepted by the ingress handler. Conversation
   creation and queue submission happen asynchronously after the response;
   request history cannot prove or correlate successful dispatch.
6. Explain that every accepted request attempts to start a separate
   conversation asynchronously.

## Commands

### List

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs list
```

### Create a public webhook

Use only when the user explicitly accepts a public capability URL:

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs create \
  --name "Build events" \
  --preprompt "Summarize this build event and tell the user whether action is needed." \
  --public
```

### Create a secured webhook with a generated credential

Prefer this for normal secured creation. Choose a unique new filename; the
helper refuses to overwrite an existing file.

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs create \
  --name "Pager events" \
  --preprompt "Triage this pager event and summarize its urgency." \
  --secure \
  --credential-output /root/downloads/pager-events-webhook-credential.json
```

The output reports the webhook URL and credential-file path but not the file's
contents. Return the URL in chat and a private download link for the file. The
file contains the generated security key and complete `Authorization` header,
is created with mode `0600` on POSIX systems, and must be treated as a secret.
The helper writes and syncs it before the API request. It removes the file only
after a definitive rejection; once dispatch begins it preserves the credential
across connection resets, 5xx responses, truncated success bodies, malformed
responses, close failures, and stdout failures. Do not use `cat`, JSON
inspection, shell
interpolation, or any other operation that would put its contents in the agent
transcript. Delete the sandbox copy after the user confirms safe receipt.

### Create a webhook with a user-supplied security key

Use this advanced path only when the user already controls the key and does not
need a generated credential file.

Read the key from stdin without echoing or placing it in process arguments:

```bash
printf '%s' "$WEBHOOK_SECURITY_KEY" | \
  node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs create \
    --name "Pager events" \
    --preprompt "Triage this pager event and summarize its urgency." \
    --security-key-stdin
```

The caller sends `Authorization: Basic <base64("webhook:<security-key>")>`.
Do not print that header or the key. The helper derives it internally for test
requests when the same key is piped through stdin.

### Test acceptance

Public webhook:

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs test \
  --webhook-id webhook-agent-... \
  --confirm
```

Secured webhook using the generated credential file:

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs test \
  --webhook-id webhook-agent-... \
  --credential-file /root/downloads/pager-events-webhook-credential.json \
  --payload-file /tmp/event.json \
  --confirm
```

The helper reads the authorization header internally; it does not print it.
When the generated JSON contains both fields, the helper verifies that
`authorization_header` matches `security_key` before sending a request.

Secured webhook using a user-supplied key:

```bash
printf '%s' "$WEBHOOK_SECURITY_KEY" | \
  node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs test \
    --webhook-id webhook-agent-... \
    --payload-file /tmp/event.json \
    --security-key-stdin \
    --confirm
```

For a custom payload, prefer an existing protected JSON file. Never place
sensitive payload JSON directly in argv, shell history, or process listings.
Delete temporary payload files after the test.

Inspect recent accepted requests separately:

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs requests \
  --webhook-id webhook-agent-... \
  --limit 5
```

Pass `--include-body` only when the user needs payload contents and it is safe
to display them. Request history is written fire-and-forget and cannot be
correlated with the test command, so do not use it as proof of dispatch.

### Enable or disable

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs disable \
  --webhook-id webhook-agent-... --confirm

node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs enable \
  --webhook-id webhook-agent-...
```

### Rotate or delete

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs rotate \
  --webhook-id webhook-agent-... --confirm

node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs delete \
  --webhook-id webhook-agent-... --confirm
```

After rotation, give the user the new URL and clearly state that the old one no
longer works.

## Errors

- `404 Webhook not found` on management routes can mean the webhook feature is
  unavailable to the organization, the webhook ID is wrong, or the caller
  lacks permission. Do not claim the agent itself is missing without checking
  the response's `errorCode`.
- `401 Unauthorized` from a webhook test means the endpoint requires Basic
  auth and the supplied key was missing or wrong.
- If secure creation says its status is unknown or may have succeeded, keep the
  credential file, run `list`, and reconcile the requested name before retrying
  or deleting anything. A retry without reconciliation can create a duplicate.
- If cleanup reports that a sensitive file may remain, tell the user the path
  without reading it and remove it manually once it is safe to do so.
- Malformed credential or payload JSON produces a fixed diagnostic that does
  not quote source fragments. Repair the protected file outside the transcript;
  never paste its contents into chat to diagnose it.
- A `202 {"ok":true}` response means accepted by the ingress handler, not
  dispatched or completed. Do not report successful conversation creation or
  queueing from that response or from the history `enqueued` field; the server
  currently derives that field from the same `202` status.
