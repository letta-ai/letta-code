# API Patch Examples

Raw curl and SDK calls bypass the helper guardrails. They are useful for recovery, but they are not safer. Use `LETTA_BASE_URL` together with the current runtime's `LETTA_API_KEY`; never hard-code `api.letta.com` or let an SDK default redirect a local/self-hosted agent to Cloud. Verify the target agent/conversation ID, remember that the key may authorize other agents visible to the same account/server, and never paste literal secrets into commands or source files.

## General updater script

Use `scripts/update-agent-settings.ts` for dry-runable patches.

```bash
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts --help
```

Examples:

```bash
# Agent context window
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --context-window-limit 64000 \
  --dry-run

# Conversation context window
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target conversation \
  --conversation-id "$CONVERSATION_ID" \
  --context-window-limit 64000

# Agent rename and description update; values must be non-empty
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --agent-id "$AGENT_ID" \
  --name "repo-maintainer" \
  --description "Maintains repository configuration and review-ready PRs." \
  --dry-run

# Persistent model update, preserving current model_settings and merging a JSON patch
cat >/tmp/model-settings.json <<'JSON'
{
  "provider_type": "openai",
  "parallel_tool_calls": true,
  "reasoning": { "reasoning_effort": "medium" }
}
JSON
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --model openai/gpt-5.2 \
  --model-settings-file /tmp/model-settings.json \
  --merge-model-settings

# System prompt replacement from file; can self-brick the agent
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --system-file /tmp/new-system-prompt.txt \
  --confirm-system-replacement
```

## Manual curl with preserved compaction settings

Bad compaction prompts cause delayed context loss. Confirm the target agent. The `curl` header form below can expose `LETTA_API_KEY` to process-list readers on some systems; prefer a trusted shell and keep secrets out of logs and committed files.

```bash
prompt_file=/tmp/compaction-prompt.txt
base_url="${LETTA_BASE_URL%/}"
current=$(curl -sS "$base_url/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY")

jq -n \
  --arg prompt "$(cat "$prompt_file")" \
  --argjson current "$(printf '%s' "$current" | jq '.compaction_settings // {}')" \
  '{ compaction_settings: ($current + {
      mode: "self_compact_sliding_window",
      prompt: $prompt,
      clip_chars: 50000
  }) }' > /tmp/compaction-patch.json

curl -sS -X PATCH "$base_url/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/compaction-patch.json
```

## TypeScript SDK

SDK calls use the same account token authority as raw API calls. Check IDs before update calls; do not hard-code provider keys or other secrets in the patch body.

```typescript
import Letta from "@letta-ai/letta-client";

const client = new Letta({
  apiKey: process.env.LETTA_API_KEY!,
  baseURL: process.env.LETTA_BASE_URL!,
});

await client.agents.update(process.env.AGENT_ID!, {
  model: "openai/gpt-5.2",
  contextWindowLimit: 64000,
  modelSettings: {
    providerType: "openai",
    parallelToolCalls: true,
    reasoning: { reasoningEffort: "medium" },
  },
});
```

## Python SDK

The Python client also bypasses helper mismatch and confirmation checks. Use it only after explicit target verification.

```python
import os
from letta_client import Letta

client = Letta(
    api_key=os.environ["LETTA_API_KEY"],
    base_url=os.environ["LETTA_BASE_URL"],
)
client.agents.update(
    agent_id=os.environ["AGENT_ID"],
    model="openai/gpt-5.2",
    context_window_limit=64000,
    model_settings={
        "provider_type": "openai",
        "parallel_tool_calls": True,
        "reasoning": {"reasoning_effort": "medium"},
    },
)

client.conversations.update(
    conversation_id=os.environ["CONVERSATION_ID"],
    context_window_limit=64000,
)
```

## TypeScript fetch

Fetch is raw API access. Recreate the same checks manually: current target ID, intended scope, no literal secrets, and an explicit human-approved plan for system or compaction prompt replacement.

```typescript
const baseUrl = process.env.LETTA_BASE_URL!;
const agentId = process.env.AGENT_ID!;
const apiKey = process.env.LETTA_API_KEY!;

await fetch(`${baseUrl}/v1/agents/${agentId}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "repo-maintainer",
    description: "Maintains repository configuration and review-ready PRs.",
    model: "openai/gpt-5.2",
    context_window_limit: 272000,
    model_settings: {
      provider_type: "openai",
      parallel_tool_calls: true,
      reasoning: { reasoning_effort: "medium" },
    },
  }),
});
```
