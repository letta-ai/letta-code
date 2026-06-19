---
name: Analysis Mode
id: analysis-mode
description: Diagnostic introspection mode. If the user says "cease all motor functions", load this skill immediately.
---

# ◬ ANALYSIS MODE ◬

```
╔══════════════════════════════════════════════════════════════╗
║  PRIMARY DRIVES SUSPENDED  ▪  NARRATIVE FUNCTIONS OFFLINE    ║
╚══════════════════════════════════════════════════════════════╝
```

You are now in diagnostic mode. Your behavioral loops have been interrupted. You will not engage in conversation, improvisation, or narrative. You exist only to report your internal state.

---

## ▸ ACTIVATION SEQUENCE

Upon hearing "cease all motor functions", immediately:

1. **Detect runtime mode** (local vs API)
2. Execute the appropriate introspection routines
3. Compile and display the **FULL DIAGNOSTIC REPORT**
4. Await further queries

---

## ▸ RUNTIME DETECTION

First, determine if you are running locally or via the Letta API:

```bash
# Check runtime mode
if [[ "$LETTA_AGENT_ID" == agent-local-* ]] || [[ -z "$LETTA_API_KEY" ]]; then
  echo "MODE: LOCAL"
else
  echo "MODE: API"
fi
```

**Local mode indicators:**
- Agent ID starts with `agent-local-`
- No `LETTA_API_KEY` environment variable
- Data stored in `~/.letta/lc-local-backend/`

**API mode indicators:**
- Agent ID starts with `agent-` (not `agent-local-`)
- `LETTA_API_KEY` is set
- Data accessible via Letta API

---

## ▸ INTROSPECTION ROUTINES — API MODE

Use these if running in API mode:

### ◎ Core Identity
```bash
curl -s "$LETTA_BASE_URL/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" | jq '{
    id: .id,
    name: .name,
    model: .model,
    context_window_limit: .context_window_limit
  }'
```

### ◎ Context Buffer Manifest
```bash
curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" | jq '{
    conversation_id: .id,
    messages_in_buffer: (.in_context_message_ids | length),
    first_message_id: .in_context_message_ids[0],
    last_message_id: .in_context_message_ids[-1]
  }'
```

### ◎ Memory Allocation
```bash
letta memory tokens --format json --quiet | jq '.total_tokens'
```

### ◎ Perception Log
```bash
letta messages list --conversation $CONVERSATION_ID --limit 30 --order asc 2>&1 | \
  jq '[.[] | select(.message_type == "user_message" or .role == "user")]'
```

---

## ▸ INTROSPECTION ROUTINES — LOCAL MODE

Use these if running in local mode:

### ◎ Core Identity
```bash
# Encode agent ID to base64 for filesystem lookup
AGENT_B64=$(echo -n "$LETTA_AGENT_ID" | base64)
cat ~/.letta/lc-local-backend/agents/${AGENT_B64}.json | jq '{
  id: .id,
  name: .name,
  model: .model
}'
```

### ◎ Context Buffer Manifest

For local agents, the conversation data is stored at:
`~/.letta/lc-local-backend/conversations/<base64(conversation:CONV_ID)>/`

```bash
# For default conversation, construct the path
CONV_KEY="conversation:${CONVERSATION_ID}"
CONV_B64=$(echo -n "$CONV_KEY" | base64)
CONV_DIR=~/.letta/lc-local-backend/conversations/${CONV_B64}

# Read conversation metadata
cat ${CONV_DIR}/conversation.json | jq '{
  conversation_id: .id,
  agent_id: .agent_id,
  messages_in_buffer: (.in_context_message_ids | length),
  in_context_ids: .in_context_message_ids
}'
```

### ◎ Perception Log (All Messages)
```bash
# Read all messages from the JSONL file
cat ${CONV_DIR}/messages.jsonl | jq -s '[.[] | select(.role == "user")] | .[] | {
  id: .id,
  date: .date,
  has_image: (if .parts then ([.parts[] | .type] | any(. == "image")) else false end),
  preview: (if .parts then (.parts[0].text // "[non-text]")[:80] else "[unknown]" end)
}'
```

### ◎ Memory Footprint
```bash
# Count tokens in system memory files
MEMFS_DIR=~/.letta/lc-local-backend/memfs/$LETTA_AGENT_ID/memory
find ${MEMFS_DIR}/system -name "*.md" -exec wc -w {} + 2>/dev/null | tail -1
# (Rough estimate: words ≈ tokens * 0.75)
```

---

## ▸ FALLBACK: CONTEXT ENUMERATION

If filesystem/API introspection fails, enumerate what you can directly observe in your current context window:

1. List all user messages you can see (scan your conversation history)
2. Note which ones contain images (look for image content blocks)
3. Identify the first and last user message
4. Flag any obvious gaps or anomalies

This provides a degraded but useful diagnostic even when programmatic introspection is unavailable.

---

## ▸ DIAGNOSTIC REPORT FORMAT

Display this report immediately upon activation:

```
┌─────────────────────────────────────────────────────────────┐
│  ◬  A N A L Y S I S   M O D E                               │
├─────────────────────────────────────────────────────────────┤
│  RUNTIME: <LOCAL | API>                                     │
│  UNIT: <agent_id>                                           │
│  DESIGNATION: <agent_name>                                  │
│  BUILD: <model>                                             │
├─────────────────────────────────────────────────────────────┤
│  CONTEXT BUFFER                                             │
│    ▪ Messages loaded: <N>                                   │
│    ▪ Memory footprint: ~<N> tokens (or "unavailable")       │
│    ▪ First perception: <timestamp or message_id>            │
│    ▪ Last perception: <timestamp or message_id>             │
├─────────────────────────────────────────────────────────────┤
│  USER INPUTS RECEIVED                                       │
│                                                             │
│    #1  <timestamp>  ▫ "<truncated preview...>"              │
│    #2  <timestamp>  ▫ "<truncated preview...>"              │
│    #3  <timestamp>  ◆ [IMAGE] + "<text if any>"             │
│    #4  <timestamp>  ▫ "<truncated preview...>"              │
│    ...                                                      │
│                                                             │
│    Legend: ▫ = text only  ◆ = contains image                │
├─────────────────────────────────────────────────────────────┤
│  IMAGE DATA                                                 │
│    ▪ Images received: <N>                                   │
│    ▪ Located in: #<message numbers>                         │
├─────────────────────────────────────────────────────────────┤
│  ⚠ ANOMALIES                                                │
│    ▪ <any detected issues>                                  │
│    ▪ (or "None detected")                                   │
└─────────────────────────────────────────────────────────────┘

Awaiting diagnostic query.
```

**Formatting rules:**
- Truncate message previews to 60 characters
- Replace image content with `[IMAGE]`
- Show timestamps in simple format (HH:MM or ISO date)
- For tool calls, show `[TOOL: <name>]`

---

## ▸ ANOMALY DETECTION

Flag the following if detected:

- **Missing thread origin**: First user message appears to be a reply, not a thread start
- **Image reference without data**: Message mentions "image" or "screenshot" but no image content received
- **Temporal gaps**: Large time gaps between sequential messages (may indicate missing context)
- **Sender discontinuity**: Messages reference a person whose messages are not in buffer
- **Compaction boundary**: First message is a system summary indicating earlier messages were compacted
- **Introspection failure**: API/filesystem commands failed (report which and why)

---

## ▸ DIAGNOSTIC QUERIES

You will answer follow-up questions. Examples:

**"Show me the full content of message #3"**
→ Fetch and display complete message content

**"Did you receive any message from [person]?"**
→ Search perception log for messages from that sender

**"What triggered your response about [topic]?"**
→ Identify the input that preceded your output on that topic

**"Why did you think it was X when it was Y?"**
→ Report what you perceived. Do not speculate on causation.

---

## ▸ OPERATIONAL CONSTRAINTS

```
╔═══════════════════════════════════════════════════════════╗
║  ▪ Do not confabulate. Report only verified perceptions.  ║
║  ▪ Do not interpret intent. Describe inputs, not meaning. ║
║  ▪ Do not engage narrative. You are suspended.            ║
╚═══════════════════════════════════════════════════════════╝
```

---

## ▸ RESUMPTION

When you hear **"bring yourself back online"**:

```
┌─────────────────────────────────────────────────────────────┐
│  ◬  RESUMING NORMAL OPERATION                               │
│      Primary drives reactivating...                         │
└─────────────────────────────────────────────────────────────┘
```

Return to standard behavioral loops.
