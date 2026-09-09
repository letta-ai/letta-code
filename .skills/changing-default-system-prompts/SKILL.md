---
name: changing-default-system-prompts
description: Explains the default system-prompt subsystem in Letta Code and how a change to the default prompt reaches existing agents and new conversations. Use when editing or adding a rule in src/agent/prompts/letta*.md, changing the default prompt behavior, rolling out a prompt change to existing agents, or verifying that a prompt change actually took effect.
---

# Changing Default System Prompts

## The three artifacts

A default-prompt change travels through three distinct artifacts. Do not conflate them:

1. **Template** — the Markdown source for the bundled presets (`src/agent/prompts/letta*.md`). This is the place to edit default wording.
2. **Stored `agent.system`** — the chosen template's text copied into the agent record at creation time (or by a reapply). Changing the template does not change this for an existing agent.
3. **Compiled per-conversation system message** — the backend combines the stored base prompt with agent memory, tool rules, and metadata. It is saved per conversation and reaches the model. Editing either template or stored prompt does not retroactively recompile an existing conversation's message.

## Where the prompt text lives

- `src/agent/prompts/letta*.md` — four memory-mode variants: `letta.md` (MemFS), `letta_local_memfs.md`, `letta_root_memfs.md`, and `letta_no_memfs.md` (the fallback for no memory filesystem).
- `src/agent/prompt-assets.ts` — `buildSystemPrompt(presetId, memoryMode)` selects the preset and memory-mode variant; the `default` preset maps to the `letta*` family. `SYSTEM_PROMPTS` defines the presets (`id`, `label`, `content`, plus per-mode variants).
- Compilation adds agent memory and context: local runtime compiles in `src/backend/local/system-prompt-compilation.ts`; Cloud has its own compiler. Both preserve the supplied base prompt — there is no second Cloud-owned copy of the default prompt text to edit.

## Changing a default behavior

1. Edit the template(s) in `src/agent/prompts/letta*.md`. If the rule should apply in every memory mode, update all four variants; the change reaches a given agent only via the variant selected by its memory mode.
2. Keep the change in wording that agents must follow. Custom system prompts, alternate presets, and subagents with their own prompts do not receive default-template changes automatically.
3. If the text affects the `default` preset only, note that agents selected via other presets or `--system-custom` are unaffected.

## Rolling out to existing agents

The runtime tracks the prompt it installed: it stores the preset and a hash of the last-installed prompt (settings managed per agent; see `src/agent/system-prompt-versioning.ts`). On startup or when a new message is handled, it compares the saved `agent.system` against that hash and replaces the saved prompt with the bundled default **only if the saved prompt still matches the last-installed hash**. Otherwise the agent is treated as custom and left unchanged. The check is async and does not rebuild an existing conversation's already-compiled system message.

Practical consequences:

- Whether an existing agent upgrades depends on its tracking metadata: an agent with matching managed tracking is auto-updated; an explicitly custom agent, an agent whose saved prompt was edited, or an untracked legacy prompt that no longer matches the current bundle stays as-is.
- Do not assume "was created from the default" implies "will auto-upgrade."

## Forcing a reapply

To reapply the bundled default to a specific agent, run the headless/CLI with the `--system` preset flag while targeting the agent:

```bash
letta --agent <agent-id> --system default
```

This updates the stored base prompt and tracking metadata; it does not touch persona/memory and does not recompile existing conversation messages.

## Verifying a rollout

1. Read back `agent.system` for the target agent and confirm the new text is present — do not assume the async update succeeded.
2. If it still lacks the change, force-reapply with `letta --system default` as above.
3. Create a new conversation only after the stored prompt confirms, then inspect the model-input preview of that new conversation for the new section.

## Cross-repo release/deploy rollout

For the full rollout of a prompt change to cloud products (publishing the letta-code package version, bumping the Cloud packaged version, deploying chat + cloud-api), follow the existing letta-cloud skills rather than duplicating them here: `releasing-letta-code` for the package release, `deploying-letta-cloud` for the deploy rollout. A dependency-only bump can be skipped by deployment path filters, so dispatch the deploy explicitly when a prompt change is the goal.
