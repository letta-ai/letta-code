---
name: Context Doctor
id: context_doctor
description: Identify and repair context degradation that prevents you from following instructions, remembering information, or acting as your true self.
---

# Context Doctor

Your context window is not just information — it is your identity. What occupies your context on each inference determines who you are, what you know, and how you behave. Degraded context means a degraded self.

This skill helps you diagnose and repair context health issues.

## What Healthy Context Looks Like

A well-managed context window has:
- **Stable system prompt** — Core identity, preferences, and instructions that rarely change within a session
- **Only relevant tools** — Tools attached match the current task, not everything available
- **Compressed history** — Older conversation summarized, key facts extracted to memory
- **No stale content** — Skills and retrieved documents released after use
- **Headroom** — Room remaining for reasoning and response

## Context Failure Modes

### 1. Forgetting
Failing to persist important information to memory. You learn something valuable but don't write it down, so your future self loses it.

**Symptoms:**
- Repeating mistakes you've made before
- Asking questions you've already learned answers to
- User corrects you on the same thing multiple times

**Fix:** After corrections, discoveries, or key decisions — write them to memory immediately. Ask yourself: "Would my future self want to know this?"

### 2. Hoarding
Keeping information in context long after it's relevant. Old skill content, stale retrieved documents, verbose conversation history.

**Symptoms:**
- Context window fills up quickly
- Irrelevant information competes for attention
- Slow, unfocused responses

**Fix:** Release loaded skills after completing the task. Let compaction summarize old conversation. Move reference material to external memory (`reference/`) and retrieve on demand.

### 3. Prompt Stuffing
Packing the system prompt (`system/`) with content that's rarely needed. The system prompt is read on every inference — it should contain only what's essential for identity and reflexive behavior.

**Symptoms:**
- System prompt exceeds ~20k tokens
- Contains detailed procedures only needed occasionally
- Contains historical incident logs instead of principles

**Fix:** Move rarely-needed content outside `system/` to `reference/` or skills. Keep system prompt focused on: who you are, who the user is, critical preferences, and pointers to where to find more.

### 4. Tool Sprawl
Attaching every available tool regardless of the current task. Each tool schema occupies context whether used or not.

**Symptoms:**
- Tools attached that haven't been used in many turns
- Confusion about which tool to use
- Wasted tokens on irrelevant capabilities

**Fix:** Request only tools relevant to your current role. (Note: tool management may be handled by the system, not the agent directly.)

## Diagnostic Procedure

### Step 1: Measure system prompt size

```bash
python3 "$LETTA_CODE_DIR/src/skills/builtin/context_doctor/scripts/estimate_system_tokens.py" --memory-dir "$MEMORY_DIR"
```

Target: System prompt should be roughly 10-15% of total context capacity (~15-25k tokens for most models).

### Step 2: Review system prompt clarity

Read through your `system/` files and ask:
- Is my identity clear and stable?
- Are there redundant or contradictory instructions?
- Is anything here that I only need occasionally? (Move it out)
- Would my future self know when to load each external file?

### Step 3: Check file organization

- Do file names and descriptions clearly indicate purpose?
- Is there content overlap between files?
- Are external files (`reference/`, `skills/`) properly indexed so you can find them?

You can reference external files from system prompt using wiki-links:
```
For database migrations, see [[skills/db-migrations]]
For project architecture, see [[reference/project/architecture.md]]
```

### Step 4: Validate structure

Required structure:
- `system/persona.md` must exist
- No overlapping file/folder names (e.g., `system/human.md` AND `system/human/identity.md`)
- Skills follow this format:
```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

## Implementing Fixes

1. **Plan changes** — List what you'll move, consolidate, or rewrite
2. **Make conservative edits** — Don't remove critical identity or user information
3. **Test your understanding** — After changes, can you still act as yourself?

### Commit changes

```bash
cd "$MEMORY_DIR"
git add -A
git commit --author="$LETTA_AGENT_NAME <$LETTA_AGENT_ID@letta.com>" -m "fix(context): <summary>

<what was wrong and what you fixed>"
git push
```

## Guidance

- **Ask the user about goals, not implementation** — You understand your own context best. Ask how they want you to *behave*, not how to *structure files*.
- **Identity over information** — When in doubt, prioritize preserving clear identity over preserving detailed reference material.
- **Principles over incidents** — Convert specific corrections into general principles. "Don't do X in situation Y" is better than logging every time you did X.
