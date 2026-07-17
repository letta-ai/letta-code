# API Patch Examples

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

# System prompt replacement from file
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --system-file /tmp/new-system-prompt.txt
```

## Manual curl with preserved compaction settings

```bash
prompt_file=/tmp/compaction-prompt.txt
current=$(curl -sS "$BASE_URL/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY")

jq -n \
  --arg prompt "$(cat "$prompt_file")" \
  --argjson current "$(printf '%s' "$current" | jq '.compaction_settings // {}')" \
  '{ compaction_settings: ($current + {
      mode: "self_compact_sliding_window",
      prompt: $prompt,
      clip_chars: 50000
  }) }' > /tmp/compaction-patch.json

curl -sS -X PATCH "$BASE_URL/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/compaction-patch.json
```

## TypeScript SDK

```typescript
import { Letta } from "@letta-ai/letta-client";

const client = new Letta({ token: process.env.LETTA_API_KEY! });

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

```python
import os
from letta_client import Letta

client = Letta(token=os.environ["LETTA_API_KEY"])
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

```typescript
const baseUrl = process.env.LETTA_BASE_URL ?? "https://api.letta.com";
const agentId = process.env.AGENT_ID!;
const apiKey = process.env.LETTA_API_KEY!;

await fetch(`${baseUrl}/v1/agents/${agentId}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
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
