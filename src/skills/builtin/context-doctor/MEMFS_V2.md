---
name: Context Doctor
id: context-doctor
description: Diagnose and repair MemFS v2 context quality.
---

# Context Doctor

Inspect the agent's system prompt, core memory, deferred memory, and skills for problems that make instructions harder to follow or relevant context harder to retrieve.

## MemFS v2 layout

- Root `MEMORY.md` and root Markdown files are core memory.
- `MEMORY.md` files have no frontmatter and use ordinary relative Markdown links.
- Every other memory Markdown file has exactly `name` and `description`.
- A child directory is memory only when it contains `MEMORY.md` at every level.
- `skills/` is separate procedural memory and is never part of a memory index.
- `system/` is not used.

## Diagnose

Run the format-aware token report:

```bash
letta memory tokens --agent "$AGENT_ID" --format json --quiet
```

Treat roughly 10% of the context window as a soft target for core memory. Do not cut useful detail merely to meet a number. In-context examples and rationale also guide attention and reasoning.

Check for:

- repeated or contradictory rules
- vague file names or descriptions
- root files that are rarely useful and should be deferred
- deferred files that cannot be reached from an index
- missing or frontmatter-bearing `MEMORY.md` files
- regular files missing `name` or `description`, or carrying extra keys
- broken Markdown links
- stale skills or near-duplicate workflows
- identity drift in persona and human files

## Repair

Make the smallest changes that resolve confirmed problems. Preserve persona, user identity, specific examples, and reasons behind learned rules. Move whole detailed topics into indexed directories instead of compressing them into vague summaries.

Update every affected `MEMORY.md` after moving files. Keep skills separate. Never store secrets.

Before committing, verify the root marker, every child marker, exact frontmatter, links, token estimate, and a clean focused diff. Explain significant identity or structure changes to the user before applying them.
