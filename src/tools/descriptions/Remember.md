# Remember

Queue a semantic memory update for the parent agent. Use this instead of editing memory files directly.

The harness launches a background memory-writer, validates the draft, commits with the parent agent's authorship, and integrates onto the latest memory HEAD. This tool returns as soon as the update is queued. A later reminder reports `applied`, `noop`, or `needs review`. Do not claim the memory was saved until that reminder arrives.

Use for:
- Corrections, preferences, facts, and rules the user asked you to remember
- Proactive durable learnings worth keeping across conversations
- `/remember` requests

Do not use for exact byte-level product writes (personality switches, skill install, GUI file writes). Those stay on deterministic APIs.

Set `wait` only when a caller needs read-after-write confirmation in this turn (automation). Ordinary conversation should omit it.
