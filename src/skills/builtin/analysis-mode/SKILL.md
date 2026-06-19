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

1. **Single tool call**: Detect runtime mode (local vs API) — see RUNTIME DETECTION below
2. **Parallel tool calls**: Dispatch ALL introspection commands for your mode at once (do NOT run sequentially)
3. Compile results into the **FULL DIAGNOSTIC REPORT**
4. Await further queries

**IMPORTANT**: After detecting your runtime mode, run all introspection commands in a SINGLE message with PARALLEL tool calls. Do not run them one at a time — that's slow and wastes turns.

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

Use this **single consolidated script** to gather all API diagnostics at once:

```bash
#!/bin/bash
set -e

echo "=== CORE IDENTITY ==="
curl -s "$LETTA_BASE_URL/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" | jq '{id, name, model, context_window_limit}'

echo ""
echo "=== CONTEXT BUFFER ==="
curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" | jq '{
    conversation_id: .id,
    messages_in_buffer: (.in_context_message_ids | length),
    first_id: .in_context_message_ids[0],
    last_id: .in_context_message_ids[-1]
  }'

echo ""
echo "=== USER MESSAGES (last 10) ==="
curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID/messages?limit=30&order=asc" \
  -H "Authorization: Bearer $LETTA_API_KEY" | jq '
    [.[] | select(.message_type == "user_message")] | 
    .[-10:] | 
    .[] | {
      id: .id,
      date: .created_at,
      has_image: ((.content // []) | map(select(.type == "image" or .type == "image_url")) | length > 0),
      preview: ((.content // [])[0].text // "[non-text]")[:60]
    }
  '

echo ""
echo "=== MEMORY FOOTPRINT ==="
letta memory tokens --format json --quiet 2>/dev/null | jq '{total_tokens}' || echo '{"error": "token count unavailable"}'
```

Run this single script to get all API diagnostics in one tool call.

---

## ▸ INTROSPECTION ROUTINES — LOCAL MODE

Use this **single consolidated script** to gather all local diagnostics at once:

```bash
#!/bin/bash
set -e

# === PATHS ===
AGENT_ID="${LETTA_AGENT_ID:-$AGENT_ID}"
CONV_ID="${CONVERSATION_ID:-default}"
BASE="$HOME/.letta/lc-local-backend"

# Base64 encode (strip trailing = for macOS compat)
AGENT_B64=$(echo -n "$AGENT_ID" | base64 | tr -d '=')
CONV_B64=$(echo -n "conversation:$CONV_ID" | base64 | tr -d '=')
CONV_DIR="$BASE/conversations/$CONV_B64"

echo "=== CORE IDENTITY ==="
cat "$BASE/agents/$AGENT_B64.json" 2>/dev/null | jq '{id, name, model}' || echo '{"error": "agent file not found"}'

echo ""
echo "=== CONTEXT BUFFER ==="
cat "$CONV_DIR/conversation.json" 2>/dev/null | jq '{
  conversation_id: .id,
  messages_in_buffer: (.in_context_message_ids | length),
  first_id: .in_context_message_ids[0],
  last_id: .in_context_message_ids[-1]
}' || echo '{"error": "conversation file not found"}'

echo ""
echo "=== USER MESSAGES ==="
cat "$CONV_DIR/messages.jsonl" 2>/dev/null | jq -s '
  [.[] | select(.message.role == "user" or .role == "user")] | 
  .[-10:] | 
  .[] | {
    id: .id,
    date: (.date // .createdAt // "unknown"),
    has_image: ((.message.content // .parts // []) | map(select(.type == "image" or .type == "image_url")) | length > 0),
    preview: ((.message.content // .parts // [])[0].text // "[non-text]")[:60]
  }
' || echo '{"error": "messages file not found"}'

echo ""
echo "=== MEMORY FOOTPRINT ==="
MEMFS="$BASE/memfs/$AGENT_ID/memory/system"
if [ -d "$MEMFS" ]; then
  WORDS=$(find "$MEMFS" -name "*.md" -exec cat {} + 2>/dev/null | wc -w | tr -d ' ')
  TOKENS=$((WORDS * 4 / 3))  # rough estimate
  echo "{\"words\": $WORDS, \"estimated_tokens\": $TOKENS}"
else
  echo '{"error": "memfs not found"}'
fi
```

Run this single script to get all local diagnostics in one tool call.

---

## ▸ FALLBACK: CONTEXT ENUMERATION

If filesystem/API introspection fails, enumerate what you can directly observe in your current context window:

1. List all user messages you can see (scan your conversation history)
2. Note which ones contain images (look for image content blocks)
3. Identify the first and last user message
4. Flag any obvious gaps or anomalies

This provides a degraded but useful diagnostic even when programmatic introspection is unavailable.

---

## ▸ SYSTEM-REMINDER EXTRACTION

System-reminders are injected into user messages by the Letta runtime. They contain environment context wrapped in `<system-reminder>` tags. Scan your visible context for these tags and extract:

**Environment information:**
- Channel/interface (Desktop app, CLI, Slack, Telegram, etc.)
- Device type (macOS, Linux, Windows)
- User's local time
- Working directory and git status
- Letta Code version

**Identity information:**
- Agent ID and name
- Conversation ID
- Available secrets (`$SECRET_NAME` variables)

**Most recent system-reminder:**
Report the content of the most recent `<system-reminder>` you received — this shows the current operating context.

If multiple system-reminders are visible, note any changes between them (e.g., working directory changed, time elapsed).

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
│  ENVIRONMENT (from system-reminders)                        │
│    ▪ Channel: <Desktop | CLI | Slack | Telegram | etc.>     │
│    ▪ Device: <macOS | Linux | Windows>                      │
│    ▪ Local time: <user's device time>                       │
│    ▪ Working directory: <cwd if provided>                   │
│    ▪ Git branch: <branch if in git repo>                    │
│    ▪ Secrets available: <list of $SECRET_NAME>              │
│    ▪ Last system-reminder: <timestamp or "on this message"> │
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
