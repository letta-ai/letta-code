---
name: Context Doctor
id: context_doctor
description: Identify and repair degradation in system prompt, external memory, and skills preventing you from following instructions or remembering information as well as you should.
---

# Context Doctor

Your context — system prompt, memory files (both `system/` and external), and skills (procedural memory) — is what makes you *you* across sessions. Over time it can degrade: bloat erodes signal, redundancy wastes tokens, poor organization makes knowledge hard to find. This skill helps you diagnose issues and repair them collaboratively with the user.

## Context Principles

These principles define what healthy context looks like. Use them as your diagnostic lens:

- **System/ is the core program**: Only durable knowledge needed every turn belongs in `system/`. Identity, active preferences, behavioral rules, project index with discovery paths, gotchas. Everything else lives outside `system/` and is loaded on demand.
- **Progressive disclosure**: Summaries and principles in `system/`; detail and evidence outside it. Frontmatter descriptions should let you decide whether to load a file without reading it. Use `[[path]]` links to create discovery paths between related context.
- **Generalize, don't memorize**: Store patterns and principles that generalize across situations, not raw events or one-off facts retrievable from conversation history.
- **Identity is project-agnostic**: `human.md` is about the user as a person — not project conventions. `persona.md` is personality and values — not project rules. The same agent may work across multiple projects.
- **Preserve semantics**: Refine, tighten, and restructure to improve clarity — but never change intended meaning. Don't alter persona-defining content, user identity, or behavioral instructions.

## Operating Procedure

### Step 1: Diagnose

Read all memory files (`system/` and optionally external as needed; use subagents for efficiency) and evaluate against the principles above. Run the token estimator alongside your review:

```bash
npx tsx <SKILL_DIR>/scripts/estimate_system_tokens.ts --memory-dir "$MEMORY_DIR"
```

Where `<SKILL_DIR>` is the Skill Directory shown when the skill was loaded (visible in the injection header).

Check for these categories of issues:

**Token bloat** — `system/` memory should take up roughly 10% of total context (~15-20k tokens):
- Is the system prompt over budget? What's consuming the most tokens?
- Are there files in `system/` that could live outside it without hurting near-term responses? Move them out and link with `[[path]]`.
- Is verbose content (evidence trails, detailed reference, long lists) living in `system/` when a lean summary + external link would suffice?

**Content quality**:
- Does each `system/` file contain generalized, actionable knowledge — or raw facts, one-off events, transient items (specific commits, current tickets, session notes)?
- Do any prompts confuse or distract you? Are critical instructions (persona, user preferences) easy to follow?
- Is there low-value content that can simply be deleted — stale facts, things retrievable on demand from conversation history?

**Organization**:
- One concept per file? Or do files mix distinct topics that should be split?
- Are file descriptions precise, non-overlapping, and accurate to their contents?
- Any redundancy — same information in multiple files? Consolidate to one canonical location.
- Any file/folder name collisions (e.g. `system/human.md` and `system/human/identity.md`)?

**Discovery paths**:
- Can you find external files (outside `system/`) when you need them? Are they referenced from `system/` with `[[path]]` links or clear descriptions?
- Do skills have informative names and descriptions so you know when to load them?

**Structural validity**:
- `system/persona.md` must exist
- Skills must follow spec: `skills/{name}/SKILL.md` with optional `scripts/`, `references/`, `assets/`
- Project directories use the project's **real name** (e.g. `letta-code/`), not generic `project/`

### Step 2: Plan and implement fixes

Present findings to the user, then create a plan and implement. Common fixes:

- **Move verbose content** outside `system/`, add `[[path]]` reference from a lean summary
- **Consolidate redundant files** into one canonical location
- **Rewrite unclear descriptions** so they enable progressive disclosure
- **Split mixed-topic files** into focused single-concept files
- **Add `[[path]]` links** to connect related context into a navigable graph
- **Delete low-value content** — stale facts, transient items, anything retrievable on demand

Before moving on, verify:
- [ ] All identified issues addressed
- [ ] No overlapping or redundant files remain
- [ ] All file descriptions are unique, accurate, and match their contents
- [ ] Moved-out knowledge has `[[path]]` references from `system/` so it can be discovered
- [ ] No semantic changes to persona, user identity, or behavioral instructions

### Step 3: Commit and push

Review changes, then commit with a descriptive message:

```bash
cd $MEMORY_DIR
git status                # Review what changed before staging
git add <specific files>  # Stage targeted paths — avoid blind `git add -A`
git commit --author="<AGENT_NAME> <<ACTUAL_AGENT_ID>@letta.com>" -m "fix(doctor): <summary> 🏥

<identified issues and implemented solutions>"

git push
```

### Step 4: Report to user

Tell the user what issues you identified, the fixes you made, and the commit. Recommend they run `/recompile` to apply changes to the current system prompt.

Before finishing:
- [ ] Resolved all identified context issues
- [ ] Pushed changes successfully
- [ ] Told the user to run `/recompile`

## Critical information
- **Ask the user about their goals for you, not the implementation**: You understand your own context best, and should follow the guidelines in this document. Do NOT ask the user about their structural preferences — the context is for YOU, not them. Ask them how they want YOU to behave or know instead.
