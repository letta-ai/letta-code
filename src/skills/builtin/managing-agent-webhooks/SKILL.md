---
name: managing-agent-webhooks
description: Creates, lists, tests, enables, disables, rotates, inspects, and deletes inbound webhooks for the current Letta Cloud agent. Use when a user asks to set up a webhook, send external events to an agent, test webhook delivery, inspect recent webhook requests, rotate a webhook URL, or remove a webhook.
---

# Managing Agent Webhooks

Use the helper script for deterministic, secret-safe webhook management. Agent
webhooks are a Letta Cloud feature: every accepted `POST` creates a new
conversation for the agent and enqueues the JSON payload as a user message.

## Safety

- Manage the current agent only. The helper rejects an explicit agent ID that
  differs from `AGENT_ID`.
- Treat each webhook URL as a capability secret. Do not post it publicly.
- Choose authentication deliberately. If the user did not specify public or
  Basic-auth access, ask before creating the webhook.
- Never put a security key on the command line or in chat. Pipe it through
  stdin from an agent secret or another non-printing source.
- The helper redacts the one-time `authorization_header` returned by the API.
- Rotating invalidates the old URL. Deleting is permanent. Use the required
  `--confirm` flag only after the user has approved that exact action.
- Request bodies may contain sensitive third-party data. `requests` omits them
  unless `--include-body` is explicitly passed.

## Environment

Live operations require:

```bash
LETTA_API_KEY=...     # supplied by the active Letta runtime
LETTA_BASE_URL=...    # use the active server; never guess or hard-code it
AGENT_ID=agent-...    # defaults to the current agent
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
3. Create the webhook and report its URL. Remind the user to treat it as a
   secret even when Basic auth is enabled.
4. Send a small smoke-test payload unless the user asked not to trigger it.
5. Read request history and confirm `status_code: 202`,
   `authorization_passed: true`, and `enqueued: true` before claiming delivery.
6. Explain that every accepted request starts a separate conversation.

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

### Create a Basic-auth webhook

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

### Test and verify

Public webhook:

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs test \
  --webhook-id webhook-agent-... \
  --payload-json '{"event":"test","message":"hello"}'
```

Secured webhook:

```bash
printf '%s' "$WEBHOOK_SECURITY_KEY" | \
  node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs test \
    --webhook-id webhook-agent-... \
    --payload-file /tmp/event.json \
    --security-key-stdin
```

Then verify delivery:

```bash
node <SKILL_DIR>/scripts/manage-agent-webhooks.mjs requests \
  --webhook-id webhook-agent-... \
  --limit 5
```

Pass `--include-body` only when the user needs payload contents and it is safe
to display them.

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
- A `202 {"ok":true}` response means accepted, not completed. Verify request
  history before reporting successful enqueueing.
