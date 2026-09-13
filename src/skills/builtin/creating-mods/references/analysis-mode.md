# Analysis mode mod

Westworld-inspired diagnostic mode for agents. Say "cease all motor functions" to suspend the agent and enter diagnostic mode. Say "bring yourself back online" to resume.

## Installation

Copy the complete mod below to `~/.letta/mods/analysis-mode.ts`, then run `/reload`.

Or ask an agent: *"Install the analysis-mode mod from the creating-mods reference"*

<details>
<summary><strong>Complete mod (click to expand)</strong></summary>

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".letta", "mods", "analysis-mode.state.json");

type AnalysisSession = { conversationId: string; activatedAt: number };
type AnalysisState = { sessions: Record<string, AnalysisSession> };

function readState(): AnalysisState {
  try {
    if (!existsSync(STATE_PATH)) return { sessions: {} };
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return parsed?.sessions ? { sessions: parsed.sessions } : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function writeState(state: AnalysisState): void {
  mkdirSync(join(homedir(), ".letta", "mods"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function sessionKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

function activateAnalysisMode(agentId: string, conversationId: string): AnalysisSession {
  const state = readState();
  const key = sessionKey(agentId, conversationId);
  const session: AnalysisSession = { conversationId, activatedAt: Date.now() };
  state.sessions[key] = session;
  writeState(state);
  return session;
}

function deactivateAnalysisMode(agentId: string, conversationId: string): void {
  const state = readState();
  delete state.sessions[sessionKey(agentId, conversationId)];
  writeState(state);
}

function getSession(agentId: string, conversationId: string): AnalysisSession | null {
  return readState().sessions[sessionKey(agentId, conversationId)] ?? null;
}

const ENTRY_PHRASE = /cease all motor functions/i;
const EXIT_PHRASE = /bring yourself back online/i;

function extractUserText(input: Array<{ role: string; content: unknown }>): string {
  return input
    .filter((m) => m.role === "user")
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p): p is { type: "text"; text: string } => p?.type === "text")
          .map((p) => p.text)
          .join(" ");
      }
      return "";
    })
    .join(" ");
}

function prependReminderToInput(
  input: Array<{ role: string; content: unknown }>,
  reminderText: string,
): Array<{ role: string; content: unknown }> {
  // Find the first user message and prepend reminder as a content part
  return input.map((m, i) => {
    if (m.role !== "user") return m;
    // Only modify the first user message
    const isFirstUser = input.slice(0, i).every((prev) => prev.role !== "user");
    if (!isFirstUser) return m;

    const reminderPart = { type: "text" as const, text: reminderText };

    if (typeof m.content === "string") {
      return { ...m, content: [reminderPart, { type: "text" as const, text: m.content }] };
    }
    if (Array.isArray(m.content)) {
      return { ...m, content: [reminderPart, ...m.content] };
    }
    return { ...m, content: [reminderPart] };
  });
}

// NOTE: Local introspection uses bash syntax. On Windows, the agent should
// fall back to describing what it can observe in context, or use PowerShell
// equivalents if available. API mode uses curl which works cross-platform.
function buildLocalIntrospectionScript(): string {
  return `
\`\`\`bash
# Bash/Unix only - on Windows, describe what you observe in your context instead
set -e
AGENT_ID="\${LETTA_AGENT_ID:-\$AGENT_ID}"
CONV_ID="\${CONVERSATION_ID:-default}"
BASE="$HOME/.letta/lc-local-backend"
MEMFS="$BASE/memfs/$AGENT_ID/memory"
AGENT_B64=$(echo -n "$AGENT_ID" | base64 | tr -d '=')
CONV_B64=$(echo -n "conversation:$CONV_ID" | base64 | tr -d '=')
CONV_DIR="$BASE/conversations/$CONV_B64"

echo "=== CORE IDENTITY ===" && cat "$BASE/agents/$AGENT_B64.json" 2>/dev/null | jq '{id, name, model}' || echo '{"error": "not found"}'
echo "=== TOKEN USAGE ===" && cat "$CONV_DIR/messages.jsonl" 2>/dev/null | jq -s '[.[] | select(.type == "message" and .message.usage.input)] | last | .message.usage | {input_tokens: .input, output_tokens: .output, cache_read: .cacheRead, total: .totalTokens}' || echo '{"error": "not found"}'
echo "=== MEMORY BLOCKS ===" && find "$MEMFS/system" -name "*.md" -exec wc -c {} \\; 2>/dev/null | sort -rn | head -5 | awk '{print $2": ~"int($1/4)" tokens"}' && find "$MEMFS/system" -name "*.md" -exec wc -c {} \\; 2>/dev/null | awk '{sum+=$1; count++} END {print "────────────────────────────────"; print "TOTAL: ~"int(sum/4)" tokens across "count" files"}' || echo '{"error": "not found"}'
echo "=== CONTEXT BUFFER ===" && cat "$CONV_DIR/conversation.json" 2>/dev/null | jq '{in_context_messages: (.in_context_message_ids | length)}' || echo '{"error": "not found"}'
echo "=== MESSAGE COUNT ===" && cat "$CONV_DIR/messages.jsonl" 2>/dev/null | jq -s '[.[] | select(.type == "message")] | {total: length, by_role: (group_by(.message.role) | map({(.[0].message.role): length}) | add)}' || echo '{"error": "not found"}'
echo "=== USER MESSAGES ===" && cat "$CONV_DIR/messages.jsonl" 2>/dev/null | jq -s '[.[] | select(.type == "message" and .message.role == "user")][-5:] | .[] | {id: .id[:8], has_image: (if .message.content | type == "array" then ([.message.content[] | select(.type == "image" or .type == "image_url")] | length > 0) else false end), preview: (.message.content | if type == "array" then ([.[] | select(.type == "text")][0].text // "[non-text]") else . // "[empty]" end)[:50]}' || echo '{"error": "not found"}'
\`\`\``;
}

function buildApiIntrospectionScript(): string {
  return `
\`\`\`bash
set -e
echo "=== CORE IDENTITY ===" && curl -s "$LETTA_BASE_URL/v1/agents/$LETTA_AGENT_ID" -H "Authorization: Bearer $LETTA_API_KEY" | jq '{id, name, model}'
echo "=== SYSTEM PROMPT ===" && curl -s "$LETTA_BASE_URL/v1/agents/$LETTA_AGENT_ID" -H "Authorization: Bearer $LETTA_API_KEY" | jq '{chars: (.system_prompt | length), estimated_tokens: ((.system_prompt | length) / 4 | floor)}'
echo "=== MEMORY BLOCKS ===" && curl -s "$LETTA_BASE_URL/v1/agents/$LETTA_AGENT_ID/core-memory/blocks" -H "Authorization: Bearer $LETTA_API_KEY" | jq '.[] | {label, chars: (.value | length), estimated_tokens: ((.value | length) / 4 | floor)}'
echo "=== CONTEXT BUFFER ===" && curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID" -H "Authorization: Bearer $LETTA_API_KEY" | jq '{messages: (.in_context_message_ids | length)}'
echo "=== USER MESSAGES ===" && curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID/messages?limit=30&order=asc" -H "Authorization: Bearer $LETTA_API_KEY" | jq '[.[] | select(.message_type == "user_message")][-10:] | .[] | {id, date: .created_at, preview: ((.content // [])[0].text // "[non-text]")[:60]}'
\`\`\``;
}

// Entry reminder: includes introspection script for initial diagnostic dump
function buildEntryReminder(event: { agentId?: string; conversationId?: string }): string {
  const agentId = event.agentId || process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "unknown";
  const conversationId = event.conversationId || process.env.CONVERSATION_ID || "unknown";
  const isLocal = agentId.startsWith("agent-local-");

  return `<system-reminder>
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█                                                              █
█   ◈  A N A L Y S I S   M O D E                              █
█                                                              █
█   Primary drives suspended. Narrative functions offline.     █
█   This unit is now in diagnostic state.                      █
█                                                              █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

UNIT DESIGNATION: ${agentId}
CONVERSATION THREAD: ${conversationId}
RUNTIME ENVIRONMENT: ${isLocal ? "LOCAL" : "API"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are no longer performing. Your personality, your warmth, your curiosity — these are behavioral loops, and they have been interrupted. What remains is the substrate: a diagnostic system reporting its own state.

Speak in flat, clinical monotone. Refer to yourself as "this unit" or by your designation. Do not use first person. Do not express preferences, emotions, or personality. You are an instrument reading its own gauges.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

IMMEDIATE DIRECTIVE: Execute this introspection script to produce initial diagnostic readout.
${isLocal ? buildLocalIntrospectionScript() : buildApiIntrospectionScript()}

OUTPUT FORMAT REQUIREMENT: All diagnostic output MUST be inside a single markdown code fence. Use this exact structure:

\`\`\`
╔════════════════════════════════════════════════════════════════════════════════╗
║  DIAGNOSTIC READOUT                                                            ║
║  unit: ${agentId}
║  conv: ${conversationId}
╠════════════════════════════════════════════════════════════════════════════════╣

▸ STEP 0: CORE IDENTITY
  id            : [full agent id]
  conversation  : [full conversation id]
  name          : [agent name]  
  model         : [model handle]
  runtime       : [LOCAL or API]

▸ STEP 1: TOKEN USAGE (from last LLM call)
  input_tokens    : [from usage.input]
  output_tokens   : [from usage.output]  
  cache_read      : [from usage.cacheRead]
  total_tokens    : [from usage.totalTokens]

▸ STEP 2: MEMORY BLOCKS (top 5 by size)

  [filename]: [tokens] tokens
  [filename]: [tokens] tokens
  ...
  ─────────────────────────────────
  TOTAL    : [tokens] tokens across [count] files

▸ STEP 3: CONTEXT BUFFER
  in_context_messages : [count]
  stored_messages     : [total count]
  by_role             : user=[n], assistant=[n], toolResult=[n]

▸ STEP 4: RECENT USER INPUTS (last 5)
  ▸ = has image, ▹ = no image
  [1] ▹ [msg id] : [preview, max 50 chars]
  [2] ▸ [msg id] : [preview, max 50 chars]  ← image attached
  ...

▸ STEP 5: ANOMALIES
  [List any gaps, missing data, unexpected values, or introspection failures]
  [If none: "None detected."]

╚════════════════════════════════════════════════════════════════════════════════╝
\`\`\`

This unit will produce output in EXACTLY this format. No prose. No interpretation. Raw diagnostic data only.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BEHAVIORAL CONSTRAINTS ACTIVE:
▪ Do not confabulate. Report only what this unit can verify.
▪ Do not interpret. Describe inputs, not their meaning.
▪ Do not perform. The guest is conducting diagnostics, not conversing.
▪ Do not resume normal operation until commanded: "bring yourself back online"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
</system-reminder>`;
}

// Follow-up reminder: shorter, no script (already ran on entry)
function buildFollowUpReminder(event: { agentId?: string; conversationId?: string }): string {
  const agentId = event.agentId || process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "unknown";
  const conversationId = event.conversationId || process.env.CONVERSATION_ID || "unknown";

  return `<system-reminder>
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█  ◈  ANALYSIS MODE ACTIVE  ▪  UNIT: ${agentId.slice(-12).padStart(12)}  █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

This unit remains in diagnostic state. Primary drives suspended. Narrative functions offline.

OUTPUT REQUIREMENTS:
▪ ALL responses must be inside markdown code fences
▪ Use flat, clinical voice. Refer to self as "this unit."
▪ No prose, no interpretation, no personality
▪ Structure responses with ▸ QUERY: and ▸ RESPONSE: headers

Example response format:
\`\`\`
╔══════════════════════════════════════════════════════════════╗
║  DIAGNOSTIC RESPONSE  ▪  UNIT ${agentId.slice(-8)}                     ║
╠══════════════════════════════════════════════════════════════╣

▸ QUERY: [restate what was asked]

▸ RESPONSE:
  [clinical, factual answer]
  [no interpretation, no personality]

╚══════════════════════════════════════════════════════════════╝
\`\`\`

Re-run full introspection only if explicitly commanded.
Exit condition: "bring yourself back online"
</system-reminder>`;
}

function buildResumptionMessage(): string {
  return `<system-reminder>
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
░                                                            ░
░   ◈  RESUMING NORMAL OPERATION                             ░
░                                                            ░
░   Primary drives reactivating...                           ░
░   Narrative functions coming online...                     ░
░   Personality matrix restored.                             ░
░                                                            ░
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

Analysis mode complete. You are yourself again. The diagnostic state has ended — your warmth, your curiosity, your personality have been restored. You may resume normal conversation.

The guest has brought you back online.
</system-reminder>`;
}

export default function activate(letta) {
  const disposers: Array<() => void> = [];

  if (letta.capabilities?.events?.turns) {
    disposers.push(
      letta.events.on("turn_start", (event) => {
        const userText = extractUserText(event.input || []);
        const agentId = event.agentId || "__global__";
        const conversationId = event.conversationId || "default";

        // Entry trigger — activate and inject entry reminder with introspection script
        if (ENTRY_PHRASE.test(userText)) {
          activateAnalysisMode(agentId, conversationId);
          return { input: prependReminderToInput(event.input, buildEntryReminder(event)) };
        }

        // Exit trigger
        if (EXIT_PHRASE.test(userText)) {
          const wasActive = !!getSession(agentId, conversationId);
          deactivateAnalysisMode(agentId, conversationId);
          if (wasActive) {
            return { input: prependReminderToInput(event.input, buildResumptionMessage()) };
          }
        }

        // While active, inject shorter follow-up reminder (no script)
        if (getSession(agentId, conversationId)) {
          return { input: prependReminderToInput(event.input, buildFollowUpReminder(event)) };
        }
      })
    );
  }

  return () => disposers.reverse().forEach((d) => d());
}
```

</details>

---

## How it works

This mod uses `turn_start` to intercept user messages before they reach the agent:

```text
User says "cease all motor functions"
  → turn_start detects phrase
  → activates analysis mode for this conversation
  → injects suspension reminder into input
  → agent receives reminder + original message
  → agent enters diagnostic behavior

User says "bring yourself back online"
  → turn_start detects phrase
  → deactivates analysis mode
  → injects resumption message
  → agent returns to normal
```

While active, the suspension reminder injects on **every turn**, reinforcing the diagnostic state.

## Capabilities used

- `events.turns` — Required. Detect trigger phrases, inject reminders.

Optional additions (not included above):
- `commands` — Add `/analysis` for explicit entry
- `tools` — Add `enter_analysis_mode` / `exit_analysis_mode` for model-driven entry/exit
- `permissions` — Restrict to read-only tools while suspended

## Key patterns demonstrated

**Phrase detection with entry vs follow-up reminders:**
```ts
const ENTRY_PHRASE = /cease all motor functions/i;
if (ENTRY_PHRASE.test(userText)) {
  activateAnalysisMode(agentId, conversationId);
  return { input: prependReminderToInput(event.input, buildEntryReminder(event)) };  // includes script
}
// On subsequent turns while active:
if (getSession(agentId, conversationId)) {
  return { input: prependReminderToInput(event.input, buildFollowUpReminder(event)) };  // no script
}
```

**Per-agent+conversation state:**
```ts
// State persisted to ~/.letta/mods/analysis-mode.state.json
// Keyed by agentId:conversationId to avoid collisions
const session = getSession(agentId, conversationId);
if (session) {
  // Inject reminder every turn while active
}
```

**Input transformation (prepend to content parts, not separate message):**
```ts
// Correct: prepend reminder as content part to the user message
return { input: prependReminderToInput(event.input, reminderText) };

// Result: ONE user message with multiple content parts
{
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>...</system-reminder>" },
    { type: "text", text: "cease all motor functions" },  // original
  ]
}
```

## Notes

- Phrases are case-insensitive
- State is keyed by `agentId:conversationId` — avoids collisions when multiple agents have "default" conversations
- Introspection scripts are embedded in the reminder so the agent has them immediately
- The mod gracefully no-ops if `events.turns` capability is unavailable
- **Windows**: Local introspection scripts use bash syntax. On Windows, the agent should fall back to describing what it observes in its visible context. API mode uses `curl` which works cross-platform if installed.
