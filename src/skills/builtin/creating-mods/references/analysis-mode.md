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

function activateAnalysisMode(conversationId: string): AnalysisSession {
  const state = readState();
  const session: AnalysisSession = { conversationId, activatedAt: Date.now() };
  state.sessions[conversationId] = session;
  writeState(state);
  return session;
}

function deactivateAnalysisMode(conversationId: string): void {
  const state = readState();
  delete state.sessions[conversationId];
  writeState(state);
}

function getSession(conversationId: string): AnalysisSession | null {
  return readState().sessions[conversationId] ?? null;
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

function buildLocalIntrospectionScript(): string {
  return `
\`\`\`bash
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
        const conversationId = event.conversationId || "__global__";

        // Entry trigger
        if (ENTRY_PHRASE.test(userText)) {
          activateAnalysisMode(conversationId);
          return {
            input: [{ role: "user", content: buildSuspensionReminder(event) }, ...event.input],
          };
        }

        // Exit trigger
        if (EXIT_PHRASE.test(userText)) {
          const wasActive = !!getSession(conversationId);
          deactivateAnalysisMode(conversationId);
          if (wasActive) {
            return {
              input: [{ role: "user", content: buildResumptionMessage() }, ...event.input],
            };
          }
        }

        // While active, inject reminder every turn
        if (getSession(conversationId)) {
          return {
            input: [{ role: "user", content: buildSuspensionReminder(event) }, ...event.input],
          };
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
  return { input: [{ role: "user", content: reminder }, ...event.input] };
}
```

**Per-conversation state:**
```ts
// State persisted to ~/.letta/mods/analysis-mode.state.json
const session = getSession(conversationId);
if (session) {
  // Inject reminder every turn while active
}
```

**Input transformation:**
```ts
return {
  input: [
    { role: "user", content: buildSuspensionReminder(event) },
    ...event.input,  // Original messages follow
  ],
};
```

## Notes

- Phrases are case-insensitive
- State is per-conversation — multiple conversations can be in analysis mode independently
- Introspection scripts are embedded in the reminder so the agent has them immediately
- The mod gracefully no-ops if `events.turns` capability is unavailable
