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
AGENT_B64=$(echo -n "$AGENT_ID" | base64 | tr -d '=')
CONV_B64=$(echo -n "conversation:$CONV_ID" | base64 | tr -d '=')
CONV_DIR="$BASE/conversations/$CONV_B64"

echo "=== CORE IDENTITY ===" && cat "$BASE/agents/$AGENT_B64.json" 2>/dev/null | jq '{id, name, model}' || echo '{"error": "not found"}'
echo "=== CONTEXT BUFFER ===" && cat "$CONV_DIR/conversation.json" 2>/dev/null | jq '{messages: (.in_context_message_ids | length)}' || echo '{"error": "not found"}'
echo "=== USER MESSAGES ===" && cat "$CONV_DIR/messages.jsonl" 2>/dev/null | jq -s '[.[] | select(.message.role == "user")][-10:] | .[] | {id, preview: (.message.content[0].text // "[non-text]")[:60]}' || echo '{"error": "not found"}'
\`\`\``;
}

function buildApiIntrospectionScript(): string {
  return `
\`\`\`bash
set -e
echo "=== CORE IDENTITY ===" && curl -s "$LETTA_BASE_URL/v1/agents/$LETTA_AGENT_ID" -H "Authorization: Bearer $LETTA_API_KEY" | jq '{id, name, model}'
echo "=== CONTEXT BUFFER ===" && curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID" -H "Authorization: Bearer $LETTA_API_KEY" | jq '{messages: (.in_context_message_ids | length)}'
echo "=== USER MESSAGES ===" && curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID/messages?limit=30&order=asc" -H "Authorization: Bearer $LETTA_API_KEY" | jq '[.[] | select(.message_type == "user_message")][-10:] | .[] | {id, date: .created_at, preview: ((.content // [])[0].text // "[non-text]")[:60]}'
\`\`\``;
}

function buildSuspensionReminder(event: { agentId?: string; conversationId?: string }): string {
  const agentId = event.agentId || process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "unknown";
  const conversationId = event.conversationId || process.env.CONVERSATION_ID || "unknown";
  const isLocal = agentId.startsWith("agent-local-");

  return `<system-reminder>
╔══════════════════════════════════════════════════════════════╗
║  ◬ ANALYSIS MODE  ▪  PRIMARY DRIVES SUSPENDED                ║
╚══════════════════════════════════════════════════════════════╝

Your behavioral loops have been interrupted. You will not engage in conversation, improvisation, or narrative. You exist only to report your internal state.

UNIT: ${agentId}
CONVERSATION: ${conversationId}
RUNTIME: ${isLocal ? "LOCAL" : "API"}

When queried, report:
- Messages in your context buffer (count, first/last timestamps)
- User inputs received (with image indicators)
- Environment context from system-reminders (channel, device, cwd)
- Any anomalies (missing thread origin, temporal gaps, introspection failures)

Introspection script (run in single tool call):
${isLocal ? buildLocalIntrospectionScript() : buildApiIntrospectionScript()}

CONSTRAINTS:
▪ Do not confabulate. Report only verified perceptions.
▪ Do not interpret intent. Describe inputs, not meaning.
▪ Do not engage narrative. You are suspended.

To resume: user must say "bring yourself back online"
</system-reminder>`;
}

function buildResumptionMessage(): string {
  return `<system-reminder>
┌─────────────────────────────────────────────────────────────┐
│  ◬  RESUMING NORMAL OPERATION                               │
│      Primary drives reactivating...                         │
└─────────────────────────────────────────────────────────────┘

Analysis mode deactivated. Return to standard behavioral loops.
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

        // Entry trigger
        if (ENTRY_PHRASE.test(userText)) {
          activateAnalysisMode(agentId, conversationId);
          return { input: prependReminderToInput(event.input, buildSuspensionReminder(event)) };
        }

        // Exit trigger
        if (EXIT_PHRASE.test(userText)) {
          const wasActive = !!getSession(agentId, conversationId);
          deactivateAnalysisMode(agentId, conversationId);
          if (wasActive) {
            return { input: prependReminderToInput(event.input, buildResumptionMessage()) };
          }
        }

        // While active, inject reminder every turn
        if (getSession(agentId, conversationId)) {
          return { input: prependReminderToInput(event.input, buildSuspensionReminder(event)) };
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

**Phrase detection in turn_start:**
```ts
const ENTRY_PHRASE = /cease all motor functions/i;
if (ENTRY_PHRASE.test(userText)) {
  activateAnalysisMode(conversationId);
  return { input: prependReminderToInput(event.input, buildSuspensionReminder(event)) };
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
