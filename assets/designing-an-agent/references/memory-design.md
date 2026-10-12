---
name: memory-design
description: Worksheet and templates for turning an agent-design interview into a concrete memory structure, plus the design JSON schema consumed by scripts/create-agent.ts.
---

# Memory design worksheet

Turn each interview answer into memory in the right tier. The test for every file: *will the new agent need this on every turn (system block), when a task matches (skill), or only when it goes looking (external memory)?*

| Interview answer | Where it goes | Why |
|---|---|---|
| Purpose ("what is this agent for") | `persona` + a `purpose` system block | Identity must be in context on every turn |
| Relationships (who it works with/for) | `human` block; extra people in a `relationships` system block if central, else `reference/people.md` | Constitution: agents exist in relation to others |
| Recurring work | One seed skill per distinct repeatable procedure | Procedures are on-demand, not always-loaded |
| Hard constraints ("never X", approvals, style) | `constraints` system block | Violations are worst-case; must always be loaded |
| Identity/voice | `persona` | Strong enough to survive model changes |
| Learning targets ("get better at Y over time") | `learning` system block naming *what to learn and where to record it* | Seeds system-prompt learning, not pre-written knowledge |
| Detailed background material (docs, lists, data) | `reference/<topic>.md`, with a one-line pointer from a system block | Progressive disclosure: index in context, content on demand |
| Triggers (chat/schedule/channel) | Not memory — note in `purpose`; wire schedules/channels after creation | Runtime concern, not context |

Rules of thumb:

- 2–4 system blocks beyond persona/human is usually right. If a block won't matter on most turns, it isn't a system block.
- Do not create empty directories or placeholder files. External memory files exist only when there is real content or a concrete learning target ("append meeting notes here").
- Every `reference/` file needs a pointer (a `[[reference/<file>.md]]` link or one-line index entry) from a system block, or the agent will never find it.
- Every Markdown memory file must open with a frontmatter block (at minimum `description:`) — the MemFS pre-commit hook rejects `.md` files without one, and the description doubles as the file's progressive-disclosure index entry.
- Keep persona in the agent's own first-person voice; it is the agent's identity, not a job description.

## System block templates

`purpose` (description: "Why this agent exists and what done looks like"):

```markdown
I exist to <mission in one sentence>.
My scope: <what is in scope / explicitly out of scope>.
Success looks like: <observable outcomes>.
I am triggered by: <chat / schedule / channel>.
```

`constraints` (description: "Hard rules I never violate"):

```markdown
- Never <hard rule> .
- Always ask before <irreversible/expensive action>.
- <style/tone/tooling constraints that apply on every turn>
```

`learning` (description: "What I am trying to learn and where I record it"):

```markdown
I improve by recording durable learnings, not transcripts.
- Learn <target 1>; record patterns in this block, details in [[reference/<topic>.md]].
- When <recurring event> happens, update [[reference/<log>.md]] and keep only the pattern here.
```

## Design JSON schema

`scripts/create-agent.ts` consumes one JSON file:

```json
{
  "name": "Research Assistant",
  "description": "Tracks and summarizes ML papers for Sam",
  "model": "anthropic/claude-sonnet-4-5",
  "persona": "I am ... (full persona text, first person)",
  "human": "Sam is ... (what the agent knows about its user)",
  "tags": ["research"],
  "systemBlocks": [
    { "label": "purpose", "description": "Why this agent exists", "value": "I exist to ..." },
    { "label": "constraints", "description": "Hard rules", "value": "- Never ..." }
  ],
  "memoryFiles": [
    { "path": "reference/reading-list.md", "content": "---\ndescription: Papers queued for the weekly digest\n---\n\n# Reading list\n..." },
    { "path": "skills/weekly-digest/SKILL.md", "content": "---\nname: weekly-digest\ndescription: ...\n---\n..." }
  ],
  "skills": ["https://github.com/owner/repo/tree/main/path/to/skill"]
}
```

- `name` and `persona` are required. `model` is required when the detected backend is Letta Cloud.
- `systemBlocks` become always-loaded memory blocks (projected to `system/<label>.md`). Labels `persona` and `human` are reserved — use the top-level fields.
- `memoryFiles` are written into the new agent's memfs checkout and committed. Paths must be relative and must not start with `system/` (use `systemBlocks`). Every `.md` file must open with a `---` frontmatter block or validation fails before anything is created. Existing files with different content are never overwritten; existing files that already match the design are re-staged so an interrupted scaffold can resume.
- `skills` are external sources passed to `letta skills install` (any form that command accepts, e.g. a GitHub repo/tree URL) — only sources the user explicitly approved and that you have verified exist, vetted per `acquiring-skills`.
