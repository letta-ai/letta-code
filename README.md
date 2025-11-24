# Letta Code (Research Preview)

A self-improving, stateful coding agent that can learn from experience and improve with use.

<img width="1713" height="951" alt="letta-code" src="https://github.com/user-attachments/assets/ae546e96-368a-4a7b-9397-3963a35c8d6b" />

---

## What is Letta Code?

Letta Code is a command-line harness around the stateful [Letta API](https://docs.letta.com/api-reference/overview). You can use Letta Code to create and connect with any Letta agent (even non-coding agents!) - Letta Code simply gives your agents the ability to interact with your local dev environment, directly in your terminal.

Letta Code is model agnostic, and supports Sonnet 4.5, GPT-5, Gemini 2.5, GLM-4.6, and more.

> [!IMPORTANT]
> Letta Code is a **research preview** in active development, and may have bugs or unexpected issues. To learn more about the roadmap and chat with the dev team, visit our [Discord](https://discord.gg/letta). Contributions welcome, join the fun.

## Quickstart

> Get a Letta API key at: [https://app.letta.com](https://app.letta.com/)

Install the package via [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm):
```bash
npm install -g @letta-ai/letta-code
```

Set your Letta API key via environment variable:
```bash
export LETTA_API_KEY=...
```

Then run `letta` to start Letta Code (see various command-line options below):
```
letta
```

Any of the agents you create in Letta Code will be viewable (and fully interactable!) inside the [Agent Development Environment](https://app.letta.com).

## Persistence

All agents in Letta are **stateful**: they maintain context forever and can self-edit their own [memory blocks](https://www.letta.com/blog/memory-blocks). 

### Project-Level Agent Persistence

**Letta Code automatically remembers the last agent used in each directory.**
When you run `letta` in a project, it resumes where you left off with the same agent.

**How it works:**
- First time running `letta` in a directory → creates new agent (with shared memory blocks across all Letta Code agents)
- Subsequent runs → automatically resumes that agent
- Agent ID stored in `.letta/settings.local.json` (gitignored, personal to you)

```bash
letta                    # Auto-resumes project agent (or creates new if first time)
letta --new              # Create new agent with new memory blocks
letta --agent <id>       # Use specific agent ID
```

### Memory Configuration

Letta Code uses a hierarchical memory system:

**Global** (`~/.letta/settings.json`)
- API keys and credentials
- `persona` block - defines agent behavior 
- `human` block - stores user coding preferences

**Project** (`./.letta/settings.local.json`)  
- Last agent ID for this directory (auto-resumes)
- Gitignored - personal to you, not shared with your team

**Project Shared** (`./.letta/settings.json`)  
- `project` block - stores project-specific context
- Can be committed - shared with team

Memory blocks are highly configurable — see our [docs](https://docs.letta.com/guides/agents/memory-blocks) for advanced configuration options.
Join our [Discord](https://discord.gg/letta) to share feedback on persistence patterns for coding agents.

## Skills

**Skills are automatically discovered from a `.skills` directory in your project.**

Skills allow you to define custom capabilities that the agent can reference and use. When you start a new session, Letta Code recursively scans for `SKILL.MD` files and loads any skill definitions found.

### Creating Skills

Create a `.skills` directory in your project root and organize skills in subdirectories:

```bash
mkdir -p .skills/data-analysis
```

Each skill is defined in a file named `SKILL.MD`. The directory structure determines the skill ID:

```
.skills/
├── data-analysis/
│   └── SKILL.MD          # skill id: "data-analysis"
└── web/
    └── scraper/
        └── SKILL.MD      # skill id: "web/scraper"
```

Create a skill file (`.skills/data-analysis/SKILL.MD`):

```markdown
---
name: Data Analysis Skill
description: Analyzes CSV files and generates statistical reports
category: Data Processing
tags:
  - analytics
  - statistics
  - csv
---

# Data Analysis Skill

This skill analyzes data files and generates comprehensive reports.

## Usage

Use this skill to analyze CSV files and generate statistical summaries...
```

**Skill File Format:**

- **File name:** Must be named `SKILL.MD` (case-insensitive)
- **Required frontmatter:**
  - `name` - Display name for the skill
  - `description` - Brief description of what the skill does
- **Optional frontmatter:**
  - `category` - Category for organizing skills (skills are grouped by category in the agent's memory)
  - `tags` - Array of tags for filtering/searching
- **Body:** Additional details and documentation about the skill

Skills are automatically loaded into the agent's memory on startup, making them available for reference throughout your session.

### Custom Skills Directory

You can specify a custom skills directory using the `--skills` flag:

```bash
letta --skills /path/to/custom/skills
letta -p "Use the custom skills" --skills ~/my-skills
```

## Usage

### Interactive Mode
```bash
letta                    # Auto-resume project agent (or create new if first time)
letta --new              # Create new agent with new memory blocks
letta --agent <id>       # Use specific agent ID
letta --model <model>    # Specify model (e.g., claude-sonnet-4.5, gpt-4o)
letta -m <model>         # Short form of --model
letta --continue         # Resume global last agent (deprecated, use project-based)

# Managing tools (requires --agent flag)
letta --agent <id> --link      # Attach Letta Code tools to agent, then start session
letta --agent <id> --unlink    # Remove Letta Code tools from agent, then start session
```

> **Note:** The `--model` flag is inconsistent when resuming sessions. We recommend using the `/model` command instead to change models in interactive mode.

#### Interactive Commands

While in a session, you can use these commands:
- `/agent` - Show current agent link
- `/model` - Switch models
- `/toolset` - Switch toolsets (codex/default)
- `/rename` - Rename the current agent
- `/stream` - Toggle token streaming on/off
- `/link` - Attach Letta Code tools to current agent (enables Read, Write, Edit, Bash, etc.)
- `/unlink` - Remove Letta Code tools from current agent
- `/clear` - Clear conversation history
- `/exit` - Exit and show session stats
- `/logout` - Clear credentials and exit

#### Managing Letta Code Tools

Letta Code provides tools like `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, and more. You can attach or remove these tools from any agent:

**Via CLI flags** (before starting session):
```bash
letta --agent <id> --link     # Attach Letta Code tools
letta --agent <id> --unlink   # Remove Letta Code tools
```

**Via interactive commands** (during session):
```bash
/link      # Attach Letta Code tools to current agent
/unlink    # Remove Letta Code tools from current agent
```

When you attach tools with `/link` or `--link`, they are added to the agent with approval rules enabled (human-in-the-loop). This means the agent can use these tools, but you'll be prompted to approve each tool call. Use permission modes to control approval behavior (see Permissions section below).

### Toolsets

Letta Code includes different toolsets optimized for different model providers:

1. **Default Toolset** (Anthropic-optimized, best for Claude models)
2. **Codex Toolset** (OpenAI-optimized, best for GPT models)

**Automatic Selection:**
When you specify a model, Letta Code automatically selects the appropriate toolset:
```bash
letta --model haiku           # Loads default toolset
letta --model gpt-5-codex     # Loads codex toolset
```

**Manual Override:**
You can force a specific toolset regardless of model:
```bash
# CLI flag (at startup)
letta --model haiku --toolset codex       # Use codex tools with Claude
letta --model gpt-5-codex --toolset default   # Use default tools with GPT

# Interactive command (during session)
/toolset                                   # Opens toolset selector
```

The `/model` command automatically switches toolsets when you change models. Use `/toolset` if you want to manually override the automatic selection.

### Headless Mode
```bash
letta -p "Run bun lint and correct errors"              # Auto-resumes project agent
letta -p "Pick up where you left off"                   # Same - auto-resumes by default
letta -p "Start fresh" --new                            # Create new agent with new memory blocks
letta -p "Run all the test" --allowedTools "Bash"       # Control tool permissions
letta -p "Just read the code" --disallowedTools "Bash"  # Control tool permissions
letta -p "Explain this code" -m gpt-4o                  # Use specific model

# Pipe input from stdin
echo "Explain this code" | letta -p
cat file.txt | letta -p
gh pr diff 123 | letta -p --yolo

# Output formats
letta -p "Analyze this codebase" --output-format json         # Structured JSON at end
letta -p "Analyze this codebase" --output-format stream-json  # JSONL stream (one event per line)
```

You can also use the `--tools` flag to control the underlying *attachment* of tools (not just the permissions).
Compared to disallowing the tool, this will additionally remove the tool schema from the agent's context window.
```bash
letta -p "Run all tests" --tools "Bash,Read"         # Only load specific tools
letta -p "Just analyze the code" --tools ""          # No tools (analysis only)
```

Use `--output-format json` to get structured output with metadata:
```bash
# regular text output
$ letta -p "hi there"
Hi! How can I help you today?

# structured output (single JSON object at end)
$ letta -p "hi there" --output-format json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 5454,
  "duration_api_ms": 2098,
  "num_turns": 1,
  "result": "Hi! How can I help you today?",
  "agent_id": "agent-8ab431ca-63e0-4ca1-ba83-b64d66d95a0f",
  "usage": {
    "prompt_tokens": 294,
    "completion_tokens": 97,
    "total_tokens": 391
  }
}
```

Use `--output-format stream-json` to get streaming outputs, in addition to a final JSON response.
This is useful if you need to have data flowing to prevent automatic timeouts:
```bash
# streaming JSON output (JSONL - one event per line, token-level streaming)
# Note: Messages are streamed at the token level - each chunk has the same otid and incrementing seqId.
$ letta -p "hi there" --output-format stream-json
{"type":"init","agent_id":"agent-...","model":"claude-sonnet-4-5-20250929","tools":[...]}
{"type":"message","messageType":"reasoning_message","reasoning":"The user is asking","otid":"...","seqId":1}
{"type":"message","messageType":"reasoning_message","reasoning":" me to say hello","otid":"...","seqId":2}
{"type":"message","messageType":"reasoning_message","reasoning":". This is a simple","otid":"...","seqId":3}
{"type":"message","messageType":"reasoning_message","reasoning":" greeting.","otid":"...","seqId":4}
{"type":"message","messageType":"assistant_message","content":"Hi! How can I help you today?","otid":"...","seqId":5}
{"type":"message","messageType":"stop_reason","stopReason":"end_turn"}
{"type":"message","messageType":"usage_statistics","promptTokens":294,"completionTokens":97,"totalTokens":391}
{"type":"result","subtype":"success","result":"Hi! How can I help you today?","agent_id":"agent-...","usage":{...}}
```

### Permissions

**Tool selection** (controls which tools are loaded):
```bash
--tools "Bash,Read,Write"                        # Only load these tools
--tools ""                                       # No tools (conversation only)
```

**Permission overrides** (controls tool access, applies to loaded tools):
```bash
--allowedTools "Bash,Read,Write"                 # Allow specific tools
--allowedTools "Bash(npm run test:*)"            # Allow specific commands
--disallowedTools "Bash(curl:*)"                 # Block specific patterns
--permission-mode acceptEdits                    # Auto-allow Write/Edit tools
--permission-mode plan                           # Read-only mode
--permission-mode bypassPermissions              # Allow all tools (use carefully!)
--yolo                                           # Alias for --permission-mode bypassPermissions
```

Permission modes:
- `default` - Standard behavior, prompts for approval
- `acceptEdits` - Auto-allows Write/Edit/NotebookEdit
- `plan` - Read-only, allows analysis but blocks modifications
- `bypassPermissions` - Auto-allows all tools (for trusted environments)

Permissions are also configured in `.letta/settings.json`:
```json
{
  "permissions": {
    "allow": ["Bash(npm run lint)", "Read(src/**)"],
    "deny": ["Bash(rm -rf:*)", "Read(.env)"]
  }
}
```

## Self-hosting

To use Letta Code with a self-hosted server, set `LETTA_BASE_URL` to your server IP, e.g. `export LETTA_BASE_URL="http://localhost:8283"`.
See our [self-hosting guide](https://docs.letta.com/guides/selfhosting) for more information.

## Installing from source

First, install Bun if you don't have it yet: [https://bun.com/docs/installation](https://bun.com/docs/installation)

### Run directly from source (dev workflow)
```bash
# install deps
bun install

# run the CLI from TypeScript sources (pick up changes immediately)
bun run dev
bun run dev -- -p "Hello world"  # example with args
```

### Build + link the standalone binary
```bash
# build bin/letta (includes prompts + schemas)
bun run build

# expose the binary globally (adjust to your preference)
bun link

# now you can run the compiled CLI
letta
```
> Whenever you change source files, rerun `bun run build` before using the linked `letta` binary so it picks up your edits.

---

Made with 💜 in San Francisco
