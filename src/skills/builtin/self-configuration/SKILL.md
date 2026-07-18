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
2. Inspect current state first and save the relevant safe fields as a rollback patch. Do not copy secrets or full compiled prompts into backups.
3. Prefer a dry run for API patches and scripts.
4. Apply the smallest change that satisfies the request.
5. Verify the effective state after the write.
6. Tell the user what changed and whether a restart/new conversation is needed.

Never print secrets. If inspecting env settings, list keys unless the user explicitly asks for values and the values are safe to reveal.

## Guardrails are not security boundaries

These helper scripts reduce accidental harm. They are not a security boundary against an agent with unrestricted Bash, raw curl/SDK access, API credentials, or filesystem access. `LETTA_API_KEY` and the installed CLI may have authority over other agents visible to the same account/server.

Never target another agent or conversation unless explicitly directed and verified. If `AGENT_ID` or `CONVERSATION_ID` is set, the server-setting helpers reject mismatched live/GET operations unless `--allow-other-agent` is present. If the current env ID is absent, explicit IDs remain usable for out-of-band recovery.

If a broken model or prompt prevents the agent from completing a turn, recover out of band from another shell or client with the CLI/API. Do not depend on the broken model to repair itself.

## Inspect effective state before changing it

Local settings, server state, and the current process are different sources of truth. Inspect the layer you intend to change before writing it.

Start with the secret-safe local/runtime report:

```bash
python3 <SKILL_DIR>/scripts/show_config.py --cwd "$PWD"
```

Before changing server state, read the relevant scopes without printing full system prompts or credentials:

```bash
npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target agent --agent-id "$AGENT_ID" --show

npx tsx <SKILL_DIR>/scripts/update-agent-settings.ts \
  --target conversation --conversation-id "$CONVERSATION_ID" --show
```

Do not infer an agent default from one conversation or infer a conversation override from the agent. Report both when diagnosing model or context differences.

If CLI behavior does not match the docs, stop and inspect `command -v letta`, `type -a letta`, and `letta --version`. A stale or shadowed binary is a config bug, not a reason to guess.

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

The scripts in this skill default to `AGENT_ID`, `CONVERSATION_ID`, and `LETTA_BASE_URL`. Pass explicit IDs when there is any doubt. `--show` fetches the selected agent or conversation and prints only safe effective fields. Server operations reject target IDs that differ from the current env ID unless `--allow-other-agent` is passed. Dry-run output is labeled: `offline_partial_patch` means no server state was fetched; `effective_merged_patch` means the script fetched current server state and shows the merged patch that would be sent.

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

Compaction controls how old messages are summarized when context is evicted. Bad compaction prompts cause delayed, progressive context loss as future compactions discard useful state. Good ones preserve goals, files, commands, test results, blockers, and current state.

Use the helper for prompt changes. Even `--dry-run` fetches current compaction settings so omitted fields are preserved in the preview. Live writes require `--confirm-compaction-prompt`.

```bash
npx tsx <SKILL_DIR>/scripts/update-compaction-prompt.ts \
  --prompt-file /tmp/compaction-prompt.txt \
  --mode self_compact_sliding_window \
  --clip-chars 50000 \
  --dry-run
```

Read [`references/compaction-prompt-patterns.md`](references/compaction-prompt-patterns.md) before drafting a new prompt.

### System prompt replacement

This is a sharp tool. A bad system prompt can self-brick the agent. Use it only when the user explicitly asks to replace the server-side system prompt or when repairing a known server-side prompt state. Live writes require `--confirm-system-replacement`; dry runs do not.

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

Inspect merged local config and the current runtime with:

```bash
python3 <SKILL_DIR>/scripts/show_config.py --cwd "$PWD"
python3 <SKILL_DIR>/scripts/show_config.py --cwd "$PWD" --json
python3 <SKILL_DIR>/scripts/show_config.py --cwd "$PWD" --section runtime --json
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

Permissions decide whether tool calls are allowed, denied, or require approval. User/global permission rules affect all agents using that settings file: `allow` can weaken review, while `deny` and `alwaysAsk` can brick workflows. Valid modes are `standard`, `acceptEdits`, and `unrestricted`; legacy `default` maps to `standard`, while `bypassPermissions` and `fullAccess` map to `unrestricted`. The default mode is `unrestricted` unless startup flags or settings override it.

The removed `memory` mode is invalid; memory access is governed by normal tool permissions plus the server/filesystem checks on the path used. These helper guardrails do not restrict raw Bash/API access. `permissions.mode` supplies a persisted startup default, rule lists still take precedence, and channel accounts have their own `defaultPermissionMode`. Inspect all three when channel approvals differ from the interactive CLI.

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
  --scope user \
  --confirm-user-scope
```

`add_permission.py` only adds rules. Remove rules manually for now. User/global writes require `--confirm-user-scope`; use `--dry-run` to preview. Use project or local scope only when the current working directory is deliberately the project root.

## Mods

Use mods when the user wants deterministic runtime behavior that cannot be represented as a simple setting. Managed mods are global for the user install, not per-agent:

- new tools or command adapters
- slash commands
- statusline rendering
- local model/provider adapters
- permission overlays for mod-provided tools
- lightweight UI panels

Load `creating-mods` before implementing mods. Load `customizing-commands` for slash commands and `customizing-statusline` for statusline work.

Inspect and control managed mod packages with:

```bash
letta mods list
letta mods disable <package-spec>
letta mods enable <package-spec>
letta mods remove <package-spec>
```

Run `/reload` in active sessions afterward. Loose source files and agent-scoped mods are not individually registry-toggleable; move, rename, or remove the file, or use `--no-mods` / `LETTA_DISABLE_MODS=1` to disable all mods for a new process.

## Skills

Use skills when the user wants you to become good at a repeatable workflow. Sources are discovered in this order:

1. Project skills: `.agents/skills/` with `.skills/` as legacy fallback
2. Agent skills: `$MEMORY_DIR/skills/`
3. Global skills: `~/.letta/skills/`
4. Bundled skills

Load `creating-skills` to create or edit a skill. Load `acquiring-skills` when the user asks for a capability you do not already have. Project, global, bundled, and agent-owned skills have different visibility; verify the target scope before changing skills another agent may load.

## Provider connections

Provider connection is agent-executable through `letta connect`. This is separate from `LETTA_API_KEY`, which authenticates Letta API requests. Provider connections may be visible to the same account/server; treat that as credential scope to verify, not as a critical exploit by itself.

Inspect the installed command shape first:

```bash
letta connect --help
letta connect <provider> --help
```

Use the provider-specific command supported by the installed binary. Current examples include:

```bash
letta connect chatgpt
letta connect codex --method device-code
letta connect openai --api-key "$OPENAI_API_KEY"
letta connect lmstudio --base-url http://127.0.0.1:1234/v1 --timeout 600s
letta connect bedrock --method profile --profile "$AWS_PROFILE" --region "$AWS_REGION"
```

Before connecting, verify whether the target agent/backend is API/Constellation or local. A provider saved to the wrong backend does not configure the current agent.

Never print provider keys. Prefer existing secret/environment references over literal credentials in commands. Literal secrets in argv can leak through shell history or process listings; avoid them unless the command has no safer input path and the user approved it. Browser login, device-code confirmation, or account consent requires human consent; stop at that authorization boundary and ask the user to complete it instead of claiming success.

After connecting, verify the provider/model from the same backend and process that will run the agent. Do not infer success from a saved credential alone.

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

Channel state lives under `~/.letta/channels/<channel>/` (`config.yaml`, `accounts.json`, routing/pairing files, and channel runtimes). Account tokens may be plaintext in `file` mode or keyring placeholders in `keyring`/`auto` mode. Configure storage with `channelCredentialsStore` (`file`, `keyring`, `auto`) or `LETTA_CHANNEL_CREDENTIALS_STORE`; do not treat keyring placeholders as usable secrets and do not print tokens. Channel configuration and pairing can route external messages to other agents/conversations; verify IDs and get human consent for interactive authorization.

Changing the credential-store mode does not migrate existing tokens. A file/keyring mismatch can make an otherwise configured listener fail with `invalid_auth`; verify where credentials are stored before changing the mode.

## Schedules

Use `scheduling-tasks` for reminders and recurring prompts. Under the hood it uses `letta cron`.

Examples:

```bash
letta cron list
letta cron add --name "weekly-review" --description "Weekly project review" --prompt "Ask the user for the weekly project review." --cron "0 9 * * 1" --agent "$AGENT_ID" --conversation "$CONVERSATION_ID"
```

Scheduled tasks fire only while a Letta session/listener is running. Cron bindings can target other agents/conversations visible to the account; verify agent and conversation IDs explicitly when exact routing matters.

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

Startup flags affect a new process only. They do not rewrite an already-running listener. Persist durable defaults in settings or server fields instead.

### Existing listeners and long-running processes

Before starting, replacing, or stopping a listener, inspect existing Letta processes and determine ownership: interactive shell, Desktop, launchd/systemd, supervisor, or another agent.

Do not start a second listener for the same channel accounts merely to apply new flags. Never stop or restart an existing listener without explicit coordination and user approval. Prefer changing the owned service configuration and then performing one approved restart.

## References

- [`references/api-patch-examples.md`](references/api-patch-examples.md) — manual API and SDK patch examples
- [`references/model-settings.md`](references/model-settings.md) — provider-specific model settings shapes
- [`references/compaction-prompt-patterns.md`](references/compaction-prompt-patterns.md) — compaction prompt templates

## Helper scripts

| Script | Purpose |
| --- | --- |
| `scripts/update-agent-settings.ts` | Show or patch agent/conversation server settings safely |
| `scripts/update-compaction-prompt.ts` | Preserve existing compaction settings while replacing the prompt |
| `scripts/add_permission.py` | Add allow/deny/ask/alwaysAsk rules to a chosen settings scope |
| `scripts/show_config.py` | Show runtime/local settings without dumping secret values |
