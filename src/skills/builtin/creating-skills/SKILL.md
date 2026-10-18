---
name: creating-skills
description: Creates or updates an Agent Skill, the reusable procedural knowledge an agent loads on demand. Use when asked to write, save, update, or improve a skill, or to turn a workflow, correction, or repeated procedure into a skill an agent or repository can reuse.
---

# Creating Skills

A skill is **procedural memory**: how to do a class of tasks. Write skills in the [Agent Skills format](https://agentskills.io/specification), and finish them without asking the user follow-up questions. Infer what you need from the conversation, the repository, and the task history.

## Is this a skill?

Letta agents have other kinds of memory. Put knowledge where it belongs:

| Knowledge | Where it goes |
|---|---|
| How to do a recurring task: steps, commands, gotchas, validation | A skill |
| Identity, preferences, and rules that apply in every turn | Core memory: root Markdown files in `$MEMORY_DIR`, which render in the system prompt |
| Facts and references needed only sometimes | Deferred memory files in `$MEMORY_DIR` subdirectories, indexed by a `MEMORY.md` |
| What happened in past conversations | Recall memory (message history), which is recorded automatically and searchable |

Do not use a skill to store facts, preferences, or event logs. If the agent already handles the task correctly without the content, do not write it at all.

## Choose an owner

Every skill belongs to an agent or to a project.

- **Agent-owned skill**, at `$MEMORY_DIR/skills/<name>/SKILL.md`. Use it for a capability specific to this agent, such as its own tools, integrations, or workflows, that it carries across every project. It is part of the agent's memory, so it is not saved until committed: run `git -C "$MEMORY_DIR" add skills/<name> && git -C "$MEMORY_DIR" commit -m "Add <name> skill"`.
- **Project-owned skill**, at `<repo>/.agents/skills/<name>/SKILL.md`. Use it for a procedure specific to one repository, such as building, testing, releasing, or debugging that code, that any agent or human working in the repo should share. It is part of the codebase, so it needs human approval: put it on a branch and open a pull request. Do not commit it directly to the default branch.

If the procedure only makes sense in one repository, the project owns it. If it is about how this agent works wherever it runs, the agent owns it. When both exist under the same name, the project skill takes precedence in that repository.

New and edited skills are discovered automatically on the next turn.

## Format

```
<name>/
├── SKILL.md          # Required: frontmatter + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation loaded on demand
└── assets/           # Optional: templates, schemas, data
```

Frontmatter must use only the fields defined by the specification:

| Field | Required | Constraint |
|---|---|---|
| `name` | Yes | 1-64 characters: lowercase `a-z`, `0-9`, and `-`. No leading, trailing, or consecutive hyphens. Must match the directory name. |
| `description` | Yes | 1-1024 characters. States what the skill does and when to use it. |
| `license` | No | License name or bundled license file. |
| `compatibility` | No | 1-500 characters. Only for real environment requirements. |
| `metadata` | No | Map of string keys to string values. |
| `allowed-tools` | No | Space-separated pre-approved tools. Experimental. |

Quote any frontmatter value that contains `: `.

## Write the description

The description is the only text an agent sees before deciding to load the skill, so it carries all triggering.

- Say what the skill does, then when to use it ("Use when...").
- Describe the user's intent, not the skill's internals, and include the words users actually say.
- Cover cases where the user does not name the domain directly.
- Mark the boundary with adjacent skills when a near-miss request would load the wrong one.

## Write the body

The body loads in full when the skill activates and competes with everything else in context. Keep `SKILL.md` under 500 lines and about 5,000 tokens.

- Add only what the agent would get wrong without it: project conventions, exact commands, non-obvious edge cases, and the specific tools or APIs to use.
- Build from real material such as the task just completed, corrections the user made, runbooks, failures, and fixes. Generic best practice adds little.
- Teach a reusable procedure, not the answer to one instance.
- Give a default with a brief escape hatch, not a menu of equal options.
- Be prescriptive only where the operation is fragile or order matters. Otherwise explain why, and leave the rest to judgment.
- Keep a **Gotchas** section in `SKILL.md` for facts that defy reasonable assumptions. Add each future correction there.
- Use templates for required output formats, checklists for multi-step workflows, and a validate-fix-repeat loop before destructive or batch steps.

Move detail into `references/` or `assets/`, and state when to read each file: "Read `references/api-errors.md` if the API returns a non-200 status." Use relative paths from the skill root and keep references one level deep.

Add a script to `scripts/` only when agents would otherwise rewrite the same logic or when the step must be exact. Scripts must be non-interactive, document their dependencies, and print actionable errors.

## Validate

Run the bundled validator, which enforces the specification's frontmatter and naming rules (the same checks as the [skills-ref](https://github.com/agentskills/agentskills/tree/main/skills-ref) reference validator, plus string-only `metadata` values):

```bash
npx tsx scripts/validate-skill.ts <path/to/skill>
```

Resolve `scripts/` relative to this skill's directory. Fix every error and run it again until it passes.

## Test

Validation proves only the format. Before reporting the skill as done:

1. Run one or two realistic prompts the skill should handle in a fresh context, once with the skill and once without it. When updating a skill, use the previous version as the baseline. Keep the skill only if it changes the outcome. Cut instructions the agent ignored or did not need.
2. Check triggering by confirming the description matches prompts that should load it and does not match near-miss prompts that need something else.

For a high-traffic skill, use the systematic loops in [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills) and [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions).

## Report

State the skill's name, owner, and path, what it changes compared with the no-skill baseline, and the commit or pull request that published it.
