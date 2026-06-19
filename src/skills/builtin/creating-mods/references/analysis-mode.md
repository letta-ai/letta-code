# Analysis mode mod example

Use this as a simpler mod example alongside plan-mode. It demonstrates phrase-triggered state transitions via `turn_start` without permission overlays or file coordination.

Inspired by Westworld's diagnostic mode: "cease all motor functions" suspends the agent, "bring yourself back online" resumes it.

## Contents

- Flow
- Capabilities used
- State
- Turn event with phrase detection
- Suspension reminder
- Introspection helpers
- Notes

## Flow

```text
User says "cease all motor functions"
-> turn_start detects phrase, activates analysis mode for conversation
-> injects suspension reminder into turn
-> agent receives reminder, enters diagnostic behavior
-> agent responds only to internal state queries
-> user says "bring yourself back online"
-> turn_start detects phrase, deactivates analysis mode
-> injects resumption message
-> agent returns to normal behavior
```

No tools required for entry/exit — phrase detection handles state transitions directly.

## Capabilities used

- `events.turns`: Detect trigger phrases in user input, inject reminders while active

Optional additions:
- `commands`: `/analysis` for explicit human entry
- `tools`: `enter_analysis_mode` / `exit_analysis_mode` for model-driven entry/exit (if you want the agent to be able to trigger it)
- `permissions`: Restrict to read-only tools while suspended (usually not needed)

## State

Simple state tracking keyed by conversation ID:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".letta", "mods", "analysis-mode.state.json");

type AnalysisSession = {
  conversationId: string;
  activatedAt: number;
};

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
  const session: AnalysisSession = {
    conversationId,
    activatedAt: Date.now(),
  };
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
  const state = readState();
  return state.sessions[conversationId] ?? null;
}
```

## Turn event with phrase detection

The core of the mod: detect trigger phrases and manage state transitions.

```ts
const ENTRY_PHRASE = /cease all motor functions/i;
const EXIT_PHRASE = /bring yourself back online/i;

function extractUserText(input: Array<{ role: string; content: unknown }>): string {
  const userMessages = input.filter((m) => m.role === "user");
  return userMessages
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

export default function activate(letta) {
  const disposers = [];

  if (letta.capabilities.events.turns) {
    disposers.push(
      letta.events.on("turn_start", (event) => {
        const userText = extractUserText(event.input);
        const conversationId = event.conversationId || "__global__";

        // Entry trigger
        if (ENTRY_PHRASE.test(userText)) {
          activateAnalysisMode(conversationId);
          return {
            input: [
              { role: "user", content: buildSuspensionReminder(event) },
              ...event.input,
            ],
          };
        }

        // Exit trigger
        if (EXIT_PHRASE.test(userText)) {
          const wasActive = !!getSession(conversationId);
          deactivateAnalysisMode(conversationId);
          if (wasActive) {
            return {
              input: [
                { role: "user", content: buildResumptionMessage() },
                ...event.input,
              ],
            };
          }
        }

        // While active, inject reminder every turn
        const session = getSession(conversationId);
        if (session) {
          return {
            input: [
              { role: "user", content: buildSuspensionReminder(event) },
              ...event.input,
            ],
          };
        }
      })
    );
  }

  return () => disposers.reverse().forEach((dispose) => dispose());
}
```

## Suspension reminder

The reminder that injects every turn while analysis mode is active. Use sci-fi aesthetics to reinforce the Westworld vibe.

```ts
function buildSuspensionReminder(event): string {
  const agentId = event.agentId || process.env.LETTA_AGENT_ID || "unknown";
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
```

## Introspection helpers

Consolidated scripts the agent can run in a single tool call to gather diagnostics.

```ts
function buildLocalIntrospectionScript(): string {
  return `\`\`\`bash
#!/bin/bash
set -e
AGENT_ID="\${LETTA_AGENT_ID:-\$AGENT_ID}"
CONV_ID="\${CONVERSATION_ID:-default}"
BASE="$HOME/.letta/lc-local-backend"
AGENT_B64=$(echo -n "$AGENT_ID" | base64 | tr -d '=')
CONV_B64=$(echo -n "conversation:$CONV_ID" | base64 | tr -d '=')
CONV_DIR="$BASE/conversations/$CONV_B64"

echo "=== CORE IDENTITY ==="
cat "$BASE/agents/$AGENT_B64.json" 2>/dev/null | jq '{id, name, model}' || echo '{"error": "not found"}'

echo "=== CONTEXT BUFFER ==="
cat "$CONV_DIR/conversation.json" 2>/dev/null | jq '{messages: (.in_context_message_ids | length)}' || echo '{"error": "not found"}'

echo "=== USER MESSAGES (last 10) ==="
cat "$CONV_DIR/messages.jsonl" 2>/dev/null | jq -s '[.[] | select(.message.role == "user")][-10:] | .[] | {id, date, preview: (.message.content[0].text // "[non-text]")[:60]}' || echo '{"error": "not found"}'
\`\`\``;
}

function buildApiIntrospectionScript(): string {
  return `\`\`\`bash
#!/bin/bash
set -e
echo "=== CORE IDENTITY ==="
curl -s "$LETTA_BASE_URL/v1/agents/$LETTA_AGENT_ID" -H "Authorization: Bearer $LETTA_API_KEY" | jq '{id, name, model}'

echo "=== CONTEXT BUFFER ==="
curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID" -H "Authorization: Bearer $LETTA_API_KEY" | jq '{messages: (.in_context_message_ids | length)}'

echo "=== USER MESSAGES (last 10) ==="
curl -s "$LETTA_BASE_URL/v1/conversations/$CONVERSATION_ID/messages?limit=30&order=asc" -H "Authorization: Bearer $LETTA_API_KEY" | jq '[.[] | select(.message_type == "user_message")][-10:] | .[] | {id, date: .created_at, has_image: ((.content // []) | any(.type == "image")), preview: ((.content // [])[0].text // "[non-text]")[:60]}'
\`\`\``;
}
```

## Notes

- Keep it simple. Unlike plan-mode, analysis-mode doesn't need permission overlays or file coordination. The phrase detection and turn reminders are the core.
- The Westworld phrases are case-insensitive. "Cease All Motor Functions" works too.
- State is per-conversation. Multiple conversations can be in analysis mode independently.
- The introspection scripts are embedded in the reminder so the agent has them available immediately without needing to load a skill.
- For a bundled/default mod, consider placing in `~/.letta/mods/analysis-mode.ts` or bundling with Letta Code.
- The agent should produce a diagnostic report on entry (the first turn after activation) and respond clinically to follow-up queries until resumed.
