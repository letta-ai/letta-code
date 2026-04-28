---
name: configuring-your-harness
description: "Configure deterministic Letta Code harness behavior, such as permission rules, lifecycle hooks, and model configuration."
---

# Configuring Your Harness

Use this skill to configure deterministic Letta Code harness behavior, primarily permissions and lifecycle hooks. It can also help with local per-agent settings like toolset, model, context window, name, and description.

## Memory vs harness

Keep these layers separate:

| Layer | What it is | How to change it |
|-------|------------|------------------|
| **Memory** | Learned state, memfs files, conversation recall, skills | Edit `$MEMORY_DIR`, use memory tooling, create/update skill files |
| **Harness** | Deterministic runtime config around the agent | Edit Letta settings JSON or call the Letta API |

Edit memory when the agent should remember or learn something. Edit the harness when runtime behavior should deterministically change.

Do **not** edit harness settings for ordinary preferences like “remember I prefer concise answers.” Store those in memory. Do edit harness settings for deterministic behavior like “always ask before shell commands,” “add a hook to block unsafe edits,” or “change this agent’s toolset.”

Decision rule: if the LLM is responsible for choosing the behavior, store the instruction in memory. If the harness should enforce the behavior outside the LLM, use this skill.

Examples:

| User asks for... | Use |
|------------------|-----|
| “Auto-approve safe `git diff` commands” | Harness permission rule |
| “Deny all `rm -rf` shell commands” | Harness permission rule or hook |
| “Run a script before every Bash call” | Harness hook |
| “Notify me when you finish a response” | Harness hook |
| “Always sign commits like XYZ” | Memory, because the LLM writes commit messages |
| “Prefer short answers” | Memory, because the LLM controls response style |
| “Remember this repo’s PR checklist” | Memory or project docs, because the LLM applies it |

## Where harness changes live

### Settings JSON files

| File | Scope | Typical contents |
|------|-------|------------------|
| `~/.letta/settings.json` | User/global | Permissions, hooks, user-wide env vars, `agents[]` entries |
| `./.letta/settings.json` | Project/shared | Project permissions and hooks, committed with the repo |
| `./.letta/settings.local.json` | Project-local | Personal project overrides, gitignored |

Precedence for settings scopes is **local > project > user**, but list-like entries such as permissions and hooks are merged. For hooks, project-local hooks run first, then project hooks, then user hooks.

Use project or local scope only when the current working directory is intentionally the project root.

### Letta API fields

Name, description, model, and context window are server-side agent fields. Change them with `PATCH /v1/agents/{agent_id}`.

Required environment:

```bash
export LETTA_API_KEY=...
export LETTA_AGENT_ID=...
```

Example:

```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name"}'
```

Load the `letta-api-client` skill for richer SDK examples.

---

## 1. Change permissions

Permissions decide which tool calls are allowed, denied, or require approval.

### Rule syntax

- Bash prefix match: `Bash(npm install:*)`, `Bash(git:*)`, `Bash(curl:*)`
- File globs: `Read(src/**)`, `Edit(**/*.ts)`, `Write(*.md)`
- Broad rules: `*`, `Bash`, `Read` — use sparingly

### Add a permission with the helper

```bash
python3 <skill-dir>/scripts/add_permission.py \
  --rule "Bash(curl:*)" \
  --type allow \
  --scope user
```

### Edit directly

```json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Read(src/**)"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": []
  }
}
```

Permissions loaded from settings files are signature-checked and can update during a running session. If behavior does not update immediately, start a fresh session.

---

## 2. Add hooks

Hooks run shell commands or LLM prompt checks in response to Letta Code events. Use them to audit actions, inject context, enforce policy, auto-format after edits, notify on completion, or block unsafe actions.

Before adding hooks, inspect existing config to avoid duplicates or contradictory policy:

```bash
python3 <skill-dir>/scripts/show_config.py
```

Read [`references/hooks.md`](references/hooks.md) when adding, debugging, or explaining hooks. It covers scopes, merge order, events, matchers, command hooks, prompt hooks, input JSON, exit codes, direct JSON format, and practical patterns.

Quick examples:

```bash
# Log every Bash tool call
python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher Bash \
  --type command \
  --command 'python3 ~/.letta/hooks/log-bash.py' \
  --scope user

# Gate edits with an LLM prompt hook
python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher "Edit|Write" \
  --type prompt \
  --prompt 'Allow only edits under src/ unless the user explicitly requested otherwise. Input: $ARGUMENTS' \
  --scope project
```

External edits to hook settings through scripts or direct JSON may require a fresh session because hooks are read through the settings manager cache. Hooks changed through in-app hook management APIs update in-memory settings immediately.

---

## 3. Change agent configuration

Agent config splits between the Letta server and local settings.

### Server-side fields (use the Letta API)

Use `PATCH /v1/agents/{agent_id}` with `$LETTA_AGENT_ID`.

**Change your model and context window:**
```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "llm_config": {
      "model": "claude-sonnet-4.5",
      "model_endpoint_type": "anthropic",
      "context_window": 200000
    }
  }'
```

**Rename yourself:**
```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "draft-v2"}'
```

**Update your description:**
```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"description": "..."}'
```

For Python / TypeScript SDK usage, see `docs.letta.com/api-overview/introduction` or load the `letta-api-client` skill.

### Local per-agent harness (edit `~/.letta/settings.json`)

The `agents[]` array stores per-agent harness preferences you can edit directly:

```json
{
  "agents": [
    {
      "agentId": "agent-abc123",
      "baseUrl": "https://api.letta.com",
      "pinned": true,
      "toolset": "default"
    }
  ]
}
```

- **`toolset`** — which tool set to load for this agent
- **`pinned`** — quick-switch visibility

Find your own entry by matching `agentId === $LETTA_AGENT_ID`, then edit the fields you need.

---

## Quick reference

| Goal | Command/change |
|------|----------------|
| Auto-approve curl | `add_permission.py --rule "Bash(curl:*)" --type allow --scope user` |
| Block `rm -rf` | Add `"Bash(rm -rf:*)"` to `permissions.deny`, or add a `PreToolUse` hook |
| Log all Bash calls | `add_hook.py --event PreToolUse --matcher Bash --type command --command '...' --scope user` |
| Auto-format after edits | `add_hook.py --event PostToolUse --matcher "Edit|Write" --type command --command '...' --scope project` |
| Gate edits with LLM | `add_hook.py --event PreToolUse --matcher "Edit|Write" --type prompt --prompt '...' --scope user` |
| Notify when done | `add_hook.py --event Stop --type command --command 'say done' --scope user` |
| Show config | `python3 <skill-dir>/scripts/show_config.py` |
| Change model | `PATCH /v1/agents/$LETTA_AGENT_ID` with `llm_config.model` |
| Change context window | `PATCH /v1/agents/$LETTA_AGENT_ID` with `llm_config.context_window` |
| Rename | `PATCH /v1/agents/$LETTA_AGENT_ID` with `name` |
| Update description | `PATCH /v1/agents/$LETTA_AGENT_ID` with `description` |
| Change toolset | Edit `agents[].toolset` in `~/.letta/settings.json` |

## After making changes

- **Permissions** — file changes are signature-checked and generally hot-reload; restart if behavior does not update.
- **Hooks** — external file edits may require a fresh session; in-app hook management updates in-memory settings immediately.
- **Letta API changes** — apply server-side immediately, but current session state may not fully reflect them until restart.
- **Model changes** — start a fresh conversation after changing them for a clean context.

## Helper scripts in this skill

| Script | Purpose |
|--------|---------|
| `scripts/add_permission.py` | Add an allow/deny/ask rule to any scope |
| `scripts/add_hook.py` | Add a command or prompt hook to any event |
| `scripts/show_config.py` | Show merged permissions, hooks, and per-agent settings across all scopes |

All three accept `--scope user|project|local`. Run `--help` for full usage.
