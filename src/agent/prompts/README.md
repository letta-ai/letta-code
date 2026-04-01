# Prompts

All prompt files are imported as text via `promptAssets.ts` (or `create.ts` for sleeptime). Files use `.md`, `.mdx` (memory blocks with YAML frontmatter), or `.txt` (system reminders injected as XML tags).

## System prompts

Selectable via the `/system` command. Each is a complete system prompt that gets a memory addon appended at build time.

| File | Used | Description |
|------|------|-------------|
| `letta.md` | Default for all agents | Letta-tuned system prompt |
| `source_claude.md` | `/system source-claude` | Near-verbatim Claude Code prompt for benchmarking |
| `source_codex.md` | `/system source-codex` | Near-verbatim OpenAI Codex prompt for benchmarking |
| `source_gemini.md` | `/system source-gemini` | Near-verbatim Gemini CLI prompt for benchmarking |

### Source prompt provenance

#### source_claude.md

- **Source:** Claude Code (Anthropic)
- **Version:** ~v2.1.50 (Feb 2026) — assembled from modular prompt files
- **Reference:** https://github.com/Piebald-AI/claude-code-system-prompts
- **Notes:** Since v2.1.20 the prompt is composed from ~110 atomic files at runtime. This is the rendered assembly for a default session (no custom output style, standard tools, TodoWrite present, Explore subagent available).

#### source_codex.md

- **Source:** OpenAI Codex CLI (gpt-5.3-codex model)
- **Version:** Extracted from codex-rs/core/models.json, base_instructions for gpt-5.3-codex
- **Reference:** https://github.com/openai/codex
- **Notes:** gpt-5.3-codex is the latest model. Its prompt differs significantly from the older gpt-5.1-codex-max_prompt.md file: adds Personality section, commentary/final channels, intermediary updates, and removes the Plan tool section.

#### source_gemini.md

- **Source:** Gemini CLI (Google)
- **Version:** snippets.ts (Feb 2026, copyright 2026 Google LLC)
- **Reference:** https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts
- **Notes:** Rendered for interactive mode, git repo present, outside sandbox, standard tools, no sub-agents, no skills, no YOLO mode, no approved plan. Tool name variables resolved. Conditional sections (YOLO mode, Plan mode, sandbox, GEMINI.md) noted but not inlined.

## Memory addons

Appended to the system prompt at build time based on the agent's memory mode. Exactly one is used per agent.

| File | Used | Description |
|------|------|-------------|
| `system_prompt_blocks.md` | Standard memory mode | Describes the virtual memory block system |
| `system_prompt_memfs.md` | Memfs memory mode | Describes the git-backed memory filesystem |

## Memory blocks (`.mdx`)

Default values for agent memory blocks. Loaded via `MEMORY_PROMPTS` in `promptAssets.ts`. Each has YAML frontmatter with `label` and `description`.

| File | Used | Description |
|------|------|-------------|
| `persona.mdx` | Default persona for all new agents | Blank-slate "ready to be shaped" |
| `persona_memo.mdx` | Overrides persona for the default Letta Code agent | Warm, curious collaborator personality |
| `persona_kawaii.mdx` | Not wired into any agent creation flow | Kawaii voice persona preset |
| `human.mdx` | Default human block for all new agents | Placeholder for learning about the user |
| `project.mdx` | Registered but not loaded into agents | Placeholder for codebase knowledge |
| `style.mdx` | Registered but not loaded into agents | Placeholder for coding preferences |
| `memory_filesystem.mdx` | Read-only block for memfs agents | Renders the memory directory tree in-context |

## Skill/command prompts

Injected when the user invokes a specific slash command.

| File | Used | Description |
|------|------|-------------|
| `remember.md` | `/remember` command | Instructs the agent to commit conversation context to memory |
| `skill_creator_mode.md` | `/skill` command | Guides the agent through designing a new skill |
| `sleeptime.md` | Sleep-time memory agent persona | Persona for the background agent that maintains memory blocks between sessions |

## System reminders (`.txt`)

Short XML-wrapped messages injected into the conversation as system events.

| File | Used | Description |
|------|------|-------------|
| `plan_mode_reminder.txt` | Plan mode active | Prevents the agent from making changes until plan is confirmed |
| `memory_check_reminder.txt` | Periodic during conversation | Prompts the agent to review and update memory blocks |
| `auto_init_reminder.txt` | Background init in progress | Tells the agent memory is being set up |
| `approval_recovery_alert.txt` | Keep-alive ping | Automated message to resume after approval timeout |
| `interrupt_recovery_alert.txt` | User interrupts stream | Notifies the agent the stream was interrupted |
