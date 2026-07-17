---
name: self-configuration
description: Modify Letta Code's own memory, model, context window, system prompt, compaction, permissions, toolsets, mods, skills, channels, schedules, and local runtime settings. Use when the user asks you to change how you behave or how the harness runs you.
license: MIT
---

# Self-Configuration

Use this skill when the user asks you to change yourself or the Letta Code runtime around you.

The important part is choosing the right layer. Do not smear a preference into deterministic config, and do not bury a deterministic safety rule in prose memory.

## First choose the layer

| Layer | Use it for | How to change it |
| --- | --- | --- |
| Memory and identity | Durable facts, style preferences, persona changes, project knowledge, reusable skills | Edit `$MEMORY_DIR` files and sync the memory repo |
| Server agent fields | Default model, model settings, context limit, system prompt, compaction, agent name, description | Patch `/v1/agents/{agent_id}` |
| Server conversation fields | Temporary model/context experiments for one conversation | Patch `/v1/conversations/{conversation_id}` |
| Local settings | Permissions, environment variables, UI/runtime preferences, pinned agents, toolset overrides, reflection cadence | Edit `~/.letta/settings.json`, `./.letta/settings.json`, or `./.letta/settings.local.json` |
| Mods | New deterministic tools, slash commands, providers, statusline behavior, or lightweight UI | Load `creating-mods`, `customizing-commands`, or `customizing-statusline` |
| Skills | Reusable procedural knowledge or bundled scripts | Load `creating-skills` or `acquiring-skills` |
| Channels | Slack/Discord/Telegram/WhatsApp/Signal accounts, pairing, routing, listener state | Use `letta channels` or channel commands |
| Schedules | Reminders and recurring prompts | Load `scheduling-tasks` and use `letta cron` |

Decision rule: if the model should remember and reason about it, use memory. If the runtime must enforce it or route it before the model decides anything, use settings, API fields, mods, channels, or schedules.

## Safe workflow

1. Identify scope: current conversation, current agent, project, or global user config.
2. Inspect current state first. Do not overwrite unknown config from a stale assumption.
3. Prefer a dry run for API patches and scripts.
4. Apply the smallest change that satisfies the request.
5. Verify the effective state after the write.
6. Tell the user what changed and whether a restart/new conversation is needed.

Never print secrets. If inspecting env settings, list keys unless the user explicitly asks for values and the values are safe to reveal.

## Memory and identity

Use memory when the user wants you to remember, prefer, learn, or change your identity/personality.

Common files:

| Path | Purpose |
| --- | --- |
| `$MEMORY_DIR/system/persona.md` | Identity, voice, behavioral defaults |
| `$MEMORY_DIR/system/human.md` | Durable notes about the person you work with |
| `$MEMORY_DIR/projects/` | Project-specific long-term context |
| `$MEMORY_DIR/skills/` | Agent-owned reusable skills |
| `$MEMORY_DIR/relationships/` | Durable relationship and collaboration notes |

After changing memory, inspect and commit the exact changed files. Push/sync according to the current harness reminder or the `syncing-memory-filesystem` skill; some environments sync committed memory automatically.

```bash
cd "$MEMORY_DIR" && git status
cd "$MEMORY_DIR" && git add <changed-files> && git commit --author="$AGENT_NAME <$AGENT_ID@letta.com>" -m "memory: <summary>"
```

Do not use API system-prompt replacement for ordinary learning. That can clobber the compiled prompt. Edit memory instead.

## Server-side agent and conversation settings

Server fields control model execution and agent metadata. Use the agent endpoint for persistent defaults. Use the conversation endpoint for scoped experiments.

Required environment for live API writes:

```bash
export LETTA_API_KEY=...
export AGENT_ID=agent-...
export CONVERSATION_ID=conv-...   # only needed for conversation-scoped changes
export LETTA_BASE_URL=https://api.letta.com   # optional; default is api.letta.com
```

The scripts in this skill default to `AGENT_ID`, `CONVERSATION_ID`, and `LETTA_BASE_URL`. Pass explicit IDs when there is any doubt. Dry-run output is labeled: `offline_partial_patch` means no server state was fetched; `effective_merged_patch` means the script fetched current server state and shows the merged patch that would be sent.

### Dry-runable update script

```bash
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts --help
```

Patch the current conversation first when testing a risky model/settings change:

```bash
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target conversation \
  --conversation-id "$CONVERSATION_ID" \
  --model "openai/gpt-5.2" \
  --context-window-limit 64000 \
  --dry-run
```

Patch the agent default after the user confirms the change should persist:

```bash
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --agent-id "$AGENT_ID" \
  --model "openai/gpt-5.2" \
  --context-window-limit 64000
```

### Name and description

Name and description are agent-level metadata. Do not pass them with `--target conversation`. Values must be non-empty; the helper does not clear metadata by accident.

```bash
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --agent-id "$AGENT_ID" \
  --name "repo-maintainer" \
  --dry-run

npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --agent-id "$AGENT_ID" \
  --description "Maintains repository configuration and review-ready PRs." \
  --dry-run
```

Do not patch `llm_config` directly. Use `model`, `context_window_limit`, and `model_settings`. For metadata, use `name` and `description`. Then read back the agent or conversation and verify the returned `llm_config.context_window`, `model_settings`, and metadata fields.

### Model settings

`model_settings` is usually replacement-style. Fetch the current object first and preserve fields you still need, or pass `--merge-model-settings`. Merge dry runs fetch current state and require `LETTA_API_KEY` because they preview preserved fields, not just the local patch fragment.

```bash
cat > /tmp/model-settings.json <<'JSON'
{
  "provider_type": "openai",
  "parallel_tool_calls": true,
  "reasoning": { "reasoning_effort": "medium" }
}
JSON

npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --agent-id "$AGENT_ID" \
  --model "openai/gpt-5.2" \
  --model-settings-file /tmp/model-settings.json \
  --merge-model-settings \
  --dry-run
```

Provider reasoning fields differ. Read [`references/model-settings.md`](references/model-settings.md) before changing reasoning or provider-specific settings.

### Compaction settings

Compaction controls how old messages are summarized when context is evicted. Bad compaction prompts lose work. Good ones preserve goals, files, commands, test results, blockers, and current state.

Use the helper for prompt changes. Even `--dry-run` fetches current compaction settings so omitted fields are preserved in the preview.

```bash
npx tsx <SKILL_DIR>/scripts/update-compaction-prompt.ts \
  --prompt-file /tmp/compaction-prompt.txt \
  --mode self_compact_sliding_window \
  --clip-chars 50000 \
  --dry-run
```

Read [`references/compaction-prompt-patterns.md`](references/compaction-prompt-patterns.md) before drafting a new prompt.

### System prompt replacement

This is a sharp tool. Use it only when the user explicitly asks to replace the server-side system prompt or when repairing a known server-side prompt state.

```bash
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent \
  --agent-id "$AGENT_ID" \
  --system-file /tmp/new-system-prompt.txt \
  --dry-run
```

For normal behavioral changes, edit memory. For startup preset selection, use `--system <preset>` or `--system-custom <file>` when launching Letta Code.

## Local settings files

Settings scopes:

| File | Scope | Typical contents |
| --- | --- | --- |
| `~/.letta/settings.json` | User/global | Permissions, env keys, experiments, UI/runtime preferences, agents[] entries |
| `./.letta/settings.json` | Project/shared | Project settings committed with the repo |
| `./.letta/settings.local.json` | Project-local | Personal project overrides, usually gitignored |

Precedence is local > project > user. Permission rule lists are merged; scalar settings usually override. When editing JSON directly, preserve unknown fields, keep the file schema-valid, and inspect the effective config afterward instead of rewriting the whole file from a guessed shape.

Inspect merged local config with:

```bash
python3 <SKILL_DIR>/scripts/show_config.py --cwd "$PWD"
python3 <SKILL_DIR>/scripts/show_config.py --cwd "$PWD" --json
```

Selected global settings keys:

| Key | Meaning |
| --- | --- |
| `tokenStreaming` | Stream tokens in UI |
| `reasoningTabCycleEnabled` | Let Tab cycle reasoning tiers when enabled |
| `showCompactions` | Show compaction activity |
| `sessionContextEnabled` | Send device/agent context at session start |
| `autoConversationTitles` | Generate conversation titles |
| `autoSwapOnQuotaLimit` | Auto-switch temporary model on quota errors |
| `includeWorktreeTool` | Include worktree tool in toolsets |
| `preferredBackendMode` | Startup backend preference, `api` or `local` |
| `channelCredentialsStore` | Channel token storage, `file`, `keyring`, or `auto` |
| `reflectionTrigger` / `reflectionStepCount` | Default reflection cadence |
| `reflectionSettingsByAgent` | Per-agent reflection cadence |
| `permissions` | Allow/deny/ask/alwaysAsk rules |
| `env` | User-wide environment variables for Letta Code |
| `experiments` | Feature flags |
| `agents[]` | Per-agent pinned/memfs/toolset/system-prompt metadata |

Per-agent `agents[]` entries are keyed by `agentId` plus server. For api.letta.com, `baseUrl` may be omitted. For another server, preserve the server key.

Base URL resolution is split between runtime API calls and settings lookup. Runtime API calls use `LETTA_BASE_URL` or an explicit script `--base-url`. Settings server keys resolve from `LETTA_SETTINGS_BASE_URL`, `env.LETTA_SETTINGS_BASE_URL`, `LETTA_BASE_URL`, `env.LETTA_BASE_URL`, then api.letta.com. Do not move `agents[]` entries across base URLs unless the user is deliberately migrating servers.

Toolset values currently include `auto`, `default`, `codex`, `codex_snake`, `gemini`, `gemini_snake`, and `none`. Use `auto` unless the user explicitly wants a manual override.

## Permissions

Permissions decide whether tool calls are allowed, denied, or require approval. Valid modes are `standard`, `acceptEdits`, and `unrestricted`; legacy `default` maps to `standard`, while `bypassPermissions` and `fullAccess` map to `unrestricted`. The default mode is `unrestricted` unless startup flags or settings override it.

Rule examples:

```json
{
  "permissions": {
    "mode": "standard",
    "allow": ["Bash(git diff:*)", "Read(src/**)"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Write(**/*.md)"],
    "alwaysAsk": ["Bash(git push:*)"]
  }
}
```

Rule types:

| Type | Behavior |
| --- | --- |
| `allow` | Approve matching calls |
| `deny` | Block matching calls |
| `ask` | Request approval in normal permission modes |
| `alwaysAsk` | Request approval even in unrestricted/yolo mode |

Add a rule with the helper:

```bash
python3 <SKILL_DIR>/scripts/add_permission.py \
  --rule "Bash(git push:*)" \
  --type alwaysAsk \
  --scope user
```

Use project or local scope only when the current working directory is deliberately the project root.

## Mods

Use mods when the user wants deterministic runtime behavior that cannot be represented as a simple setting:

- new tools or command adapters
- slash commands
- statusline rendering
- local model/provider adapters
- permission overlays for mod-provided tools
- lightweight UI panels

Load `creating-mods` before implementing mods. Load `customizing-commands` for slash commands and `customizing-statusline` for statusline work.

## Skills

Use skills when the user wants you to become good at a repeatable workflow. Sources are discovered in this order:

1. Project skills: `.agents/skills/` with `.skills/` as legacy fallback
2. Agent skills: `$MEMORY_DIR/skills/`
3. Global skills: `~/.letta/skills/`
4. Bundled skills

Load `creating-skills` to create or edit a skill. Load `acquiring-skills` when the user asks for a capability you do not already have.

## Channels

Use channels when the user wants to talk through Slack, Discord, Telegram, WhatsApp, or Signal.

Useful commands:

```bash
letta channels status
letta channels configure <channel>
letta channels install <channel>
letta channels route list --channel <channel>
letta channels pair --channel <channel> --code <code> --agent <agent-id> --conversation <conversation-id>
letta server --channels <channel>
```

Channel state lives under `~/.letta/channels/<channel>/` (`config.yaml`, `accounts.json`, routing/pairing files, and channel runtimes). Account tokens may be plaintext in `file` mode or keyring placeholders in `keyring`/`auto` mode. Configure storage with `channelCredentialsStore` (`file`, `keyring`, `auto`) or `LETTA_CHANNEL_CREDENTIALS_STORE`; do not treat keyring placeholders as usable secrets and do not print tokens.

## Schedules

Use `scheduling-tasks` for reminders and recurring prompts. Under the hood it uses `letta cron`.

Examples:

```bash
letta cron list
letta cron add --name "weekly-review" --description "Weekly project review" --prompt "Ask the user for the weekly project review." --cron "0 9 * * 1" --agent "$AGENT_ID" --conversation "$CONVERSATION_ID"
```

Scheduled tasks fire only while a Letta session/listener is running. Verify agent and conversation binding explicitly when exact routing matters.

## CLI startup flags

Some behavior is easiest to change at startup:

```bash
letta --model <model-id-or-handle>
letta --system <preset-id>
letta --system-custom /path/to/system.txt
letta --toolset auto
letta --permission-mode standard
letta --skills /path/to/skills
letta --skill-sources all,bundled,global,agent,project
letta --pre-load-skills self-configuration,creating-mods
letta --no-mods
letta --reflection-trigger step-count --reflection-step-count 25
letta --backend local
letta --memfs
```

Startup flags affect the current process. Persist durable defaults in settings or server fields instead.

## References

- [`references/api-patch-examples.md`](references/api-patch-examples.md) — manual API and SDK patch examples
- [`references/model-settings.md`](references/model-settings.md) — provider-specific model settings shapes
- [`references/compaction-prompt-patterns.md`](references/compaction-prompt-patterns.md) — compaction prompt templates

## Helper scripts

| Script | Purpose |
| --- | --- |
| `scripts/update-agent-settings.ts` | Dry-runable agent/conversation server patches |
| `scripts/update-compaction-prompt.ts` | Preserve existing compaction settings while replacing the prompt |
| `scripts/add_permission.py` | Add allow/deny/ask/alwaysAsk rules to a chosen settings scope |
| `scripts/show_config.py` | Show relevant settings without dumping secret values |
