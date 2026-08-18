---
name: initializing-memory
description: Initialize or reorganize a MemFS v2 memory repository.
---

# Memory Initialization

Initialize or reorganize the agent's memory at `$MEMORY_DIR`. Preserve existing identity and durable detail while making future retrieval easier.

## Layout

- Root `MEMORY.md` is required, has no frontmatter, and uses ordinary relative Markdown links.
- Every other root Markdown file is core memory loaded on every turn. It has exactly `name` and `description` frontmatter.
- Core filenames are flat and hyphenated. Use `persona.md`, `human.md`, `human-workflow.md`, and `<project>-gotchas.md`. Never create `system/`.
- Detailed material belongs in a directory with its own frontmatter-free `MEMORY.md`. Every parent index must link to the next index.
- `skills/` is procedural memory. It is not part of the memory index.

## What to learn

Build memory that would make the agent recognizably the same collaborator on another model:

- the user's identity, goals, motivations, communication style, and durable preferences
- the agent's own values, voice, handling of uncertainty, and learned behavioral rules
- project architecture, conventions, workflows, test commands, and recurring mistakes
- historical corrections and failure patterns that generalize

Do not store secrets, raw transcripts, temporary task state, or facts that are trivial to recover from source.

## Process

1. Read the current root `MEMORY.md`, root core files, and relevant deferred indexes.
2. Read project instructions, package manifests, README files, entry points, representative implementation files, tests, and recent git history.
3. When historical coding-agent data is available, use parallel history-analysis agents to extract corrections and patterns. Treat their output as evidence to verify, not text to paste wholesale.
4. Update existing owner files before creating new ones. Keep persona and human files project-agnostic.
5. Keep core files focused and concise. Move long architecture, evidence, and history into marker-indexed directories.
6. Add or update ordinary Markdown links in every affected `MEMORY.md`.
7. Verify exact frontmatter keys, marker coverage, link targets, and the absence of `system/`.
8. Review the diff with the user. Commit targeted paths with the agent identity, then push only when the active memory backend requires it.

## Quality checks

- `persona.md` expresses an identity rather than a generic assistant role.
- `human.md` describes the user, not project conventions.
- Each file has one clear owner topic.
- Core memory contains only information useful on most turns.
- Deferred details are reachable through `MEMORY.md` links.
- No semantic detail was lost during reorganization.
- Root `MEMORY.md` and every child index have no frontmatter.
- Every other memory Markdown file has only `name` and `description`.

Ask whether the user wants a standard or deep history/codebase pass when the requested depth is unclear. Use parallel reads and subagents for independent areas, but continue useful work while background tasks run.
