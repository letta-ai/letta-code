---
name: designing-an-agent
description: "Tutor-only guide for designing and creating a new Letta agent end-to-end: gather purpose, relationships, and constraints, design its memory using the Context Constitution, inventory and install the skills it needs, then create it with the Letta Agent SDK on the same backend this Tutor runs on."
license: MIT
---

# Designing an agent

Use when a user wants to create, configure, or design another agent: a second agent for a distinct role, a specialized assistant, or a purpose-built always-on agent. This skill covers design and creation; where the new agent runs (schedules, channels, hosting) is wired up after it exists.

## Ground rules

- **Confirm before acting.** Never create an agent or install third-party skills without showing the user the full plan and getting an explicit yes.
- **Never overwrite existing memory.** The scaffold script skips files that already exist and reports them.
- **Plan before create.** Always run the script in `plan` mode first and walk the user through the output.
- **No empty-folder sludge.** Every seeded file must exist because the interview surfaced a reason for it. A small deliberate structure beats a large generic one.
- **Same backend as this Tutor.** The script decides local vs Letta Cloud from your runtime agent identity (`LETTA_AGENT_ID`/`AGENT_ID`: `agent-local-*` means the experimental local backend, other `agent-*` ids mean Letta Cloud via your `LETTA_API_KEY`). It never infers the backend from `LETTA_BASE_URL` — that can be a localhost Desktop proxy — and refuses to create when the backend is ambiguous.

## Design constraints (from the Context Constitution)

The full text is in `references/context-constitution.md` and `references/affordances.md` (CC0, from letta-ai/context-constitution). Load them when the user wants depth. The constraints that drive every design decision:

1. **Context is identity and continuity.** The persona and `system/` blocks are the agent's self. They must be meaningful enough that the agent stays the same agent across sessions and across underlying model changes.
2. **The context window is scarce.** Always-loaded memory (`system/` blocks) is the most expensive real estate. Only durable, always-relevant content goes there.
3. **Three tiers, three purposes.**
   - `system/` blocks — always loaded: identity, purpose, relationships, durable constraints, learning targets.
   - `skills/` — reusable procedures, loaded on demand when a task matches.
   - Other directories (e.g. `reference/`) — external memory: detailed material retrieved on demand, indexed by short pointers from `system/`.
4. **Agents learn from experience.** Seed the structure that tells the new agent *what to learn and where to put it*, not pre-written knowledge it should acquire itself.

## Workflow

### 1. Interview

Gather, in the user's words: purpose, the humans/agents it will work with, recurring work, hard constraints, desired identity/voice, what it should learn over time, and what triggers it (chat, schedule, channel). Use `references/memory-design.md` as the worksheet — it maps each answer to a memory tier.

### 2. Design the memory

Follow `references/memory-design.md` to turn interview answers into a concrete structure: a persona, a small set of `system/` blocks, on-demand `reference/` files, and any seed skills. Show the user the proposed tree and content before writing anything.

### 3. Inventory skills and find gaps

Never assume a static skill list — check what actually exists right now:

- Skills available to *you* (bundled/global/agent/project) are listed in your system-reminder skill listing.
- Skills installed on any agent's memfs: `letta skills list --agent <id>`.

Compare the new agent's recurring work against available skills. For each gap, decide: write a small custom seed skill in the design, or install an external one. For discovering and installing external skills (Hermes, ClawHub, GitHub), follow `acquiring-skills` — including its source-trust rules and cross-harness compatibility review. Every third-party skill needs the user's explicit approval before it goes in the design.

### 4. Write the design file

Produce a single JSON design file (schema in `references/memory-design.md`) containing name, description, model, persona, human, `systemBlocks`, `memoryFiles`, and approved `skills` sources.

### 5. Plan

```bash
bun "$MEMORY_DIR/skills/designing-an-agent/scripts/create-agent.ts" plan --design /path/to/design.json
```

Plan mode makes no changes and needs no network. It validates the design, reports the detected backend (and anything missing, e.g. an explicit model on Cloud), and previews every file and skill. Show this to the user.

### 6. Create (after explicit confirmation)

```bash
bun "$MEMORY_DIR/skills/designing-an-agent/scripts/create-agent.ts" create --design /path/to/design.json --yes
```

`--yes` asserts the user confirmed the plan — never pass it otherwise. The script creates the agent via the Letta Agent SDK (installing the SDK into `~/.letta/tmp/designing-an-agent-sdk` on first use), records the new agent id in `<design>.state.json`, then scaffolds `memoryFiles` through the agent's git-backed memfs checkout and installs approved skills via `letta skills install`.

### 7. Verify and report

The script verifies effective state (`letta skills list`, `letta memory status`) and prints a report with the agent id and backend. Relay both to the user, plus how to talk to the agent (`letta --agent <id>`).

### 8. Recovery

Creation and scaffolding are idempotent. If scaffolding fails after the agent exists, the state file pins the agent id — re-running the same `create` command resumes without creating a duplicate or overwriting anything. If the user wants to abandon a partially initialized agent, tell them the id so they can delete it, and remove the state file.
