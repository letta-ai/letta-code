---
name: acquiring-skills
description: Guide for safely discovering and installing skills from external repositories. Use when a user asks for something where a specialized skill likely exists (browser testing, PDF processing, document generation, etc.) and you want to bootstrap your understanding rather than starting from scratch.
---

# Acquiring New Skills

This skill teaches you how to safely discover and install skills from external sources, including the Hermes Skills Hub, ClawHub (OpenClaw), GitHub repositories, and Letta community repos.

## SAFETY - READ THIS FIRST

Skills can contain:
- **Markdown files** (.md) - Risk: prompt injection, misleading instructions
- **Scripts** (Python, TypeScript, Bash) - Risk: malicious code execution

### Trusted Sources (no user approval needed for download)
- `https://github.com/letta-ai/skills` - Letta's community skills
- `https://github.com/anthropics/skills` - Anthropic's official skills
- `official/*` - Hermes official optional skills (from `NousResearch/hermes-agent`)

### Untrusted Sources (ALWAYS verify with user)
For ANY source other than the above:
1. Ask the user before downloading
2. Explain where the skill comes from
3. Get explicit approval

This includes ClawHub community skills and arbitrary GitHub repos.

### Script Safety
Even for skills from trusted sources, ALWAYS:
1. Read and inspect any scripts before executing them
2. Understand what the script does
3. Be wary of network calls, file operations, or system commands

## When to Use This Skill

**DO use** when:
- User asks for something where a skill likely exists (e.g., "help me test this webapp", "generate a PDF report")
- You think "there's probably a skill that would bootstrap my understanding"
- User explicitly asks about available skills or extending capabilities

**DON'T use** for:
- General coding tasks you can already handle
- Simple bug fixes or feature implementations
- Tasks where you have sufficient knowledge

## Ask Before Searching (Interactive Mode)

If you recognize a task that might have an associated skill, **ask the user first**:

> "This sounds like something where a community skill might help. Would you like me to search for available skills? I can check the Hermes catalog, ClawHub, or GitHub. Or I can start coding right away if you prefer."

The user may prefer to start immediately rather than wait for skill discovery.

Only proceed with skill acquisition if the user agrees.

## Skill Sources

### 1. Hermes Skills Hub (NousResearch)

Hermes has a full Skills Hub with 88k+ skills across multiple registries. It includes official optional skills shipped with the project, plus community skills from skills.sh, well-known endpoints, GitHub repos, ClawHub, LobeHub, and browse.sh.

**Searching Hermes skills:**

The Hermes CLI has built-in search and browse:

```bash
hermes skills browse                              # Browse all hub skills (official first)
hermes skills browse --source official            # Browse only official optional skills
hermes skills search kubernetes                   # Search all sources
hermes skills search react --source skills-sh     # Search the skills.sh directory
hermes skills search https://mintlify.com/docs --source well-known
hermes skills inspect openai/skills/k8s           # Preview before installing
```

The web catalog is at https://hermes-agent.nousresearch.com/docs/skills.

Hermes hub sources:

| Source | Example identifier | Notes |
|--------|--------------------|-------|
| `official` | `official/security/1password` | Optional skills shipped with Hermes |
| `skills-sh` | `skills-sh/vercel-labs/agent-skills/vercel-react-best-practices` | skills.sh directory |
| `well-known` | `well-known:https://mintlify.com/docs/.well-known/skills/mintlify` | Skills hosted at `/.well-known/skills/` |
| `url` | `https://sharethis.chat/SKILL.md` | Direct URL to a single SKILL.md |
| `github` | `openai/skills/k8s` | GitHub repo/path |
| `clawhub` | ClawHub registry skills | ClawHub marketplace |
| `lobehub` | LobeHub registry skills | LobeHub marketplace |
| `browse-sh` | `browse-sh/airbnb.com/search-listings-ddgioa` | browse.sh crawled skills |

If Hermes is not installed, you can browse the official optional skills directly:

```bash
# Browse the catalog on GitHub
# https://github.com/NousResearch/hermes-agent/tree/main/optional-skills
# Categories: autonomous-ai-agents, blockchain, creative, devops, finance,
#             health, mcp, mlops, productivity, research, security, ...

# Or clone and browse locally
git clone --depth 1 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-browse
ls /tmp/hermes-browse/optional-skills/
ls /tmp/hermes-browse/optional-skills/finance/
rm -rf /tmp/hermes-browse
```

**Installing Hermes skills** into Letta uses the `official/` prefix (for official optional skills):

```bash
letta skills install official/finance/stocks
letta skills install official/blockchain/solana
letta skills install official/research/duckduckgo-search
letta skills install official/mlops/flash-attention
letta skills install official/creative/meme-generation
```

The `official/<category>/<skill>` form clones `NousResearch/hermes-agent` and copies from `optional-skills/<category>/<skill>`.

For non-official Hermes hub skills, use the GitHub URL or shorthand form to install into Letta (e.g., `letta skills install openai/skills/k8s`).

### 2. ClawHub (OpenClaw)

ClawHub (https://clawhub.ai) is the public registry for OpenClaw skills and plugins. It hosts community-contributed skills with versioning, security scans, and search.

**Searching ClawHub skills:**

```bash
# Browse the web registry
# https://clawhub.ai

# Or use the clawhub CLI if installed
clawhub search "calendar"
clawhub search "screenshot"
clawhub explore

# Or search via the API directly
curl -s "https://clawhub.ai/api/v1/skills?q=calendar" | jq '.items[].slug'
```

**Installing ClawHub skills** uses the `clawhub/` or `clawhub:` prefix:

```bash
letta skills install clawhub/nano-banana-pro
letta skills install clawhub:nano-banana-pro
letta skills install clawhub:nano-banana-pro@1.0.1      # pin a version
letta skills install https://clawhub.ai/skills/my-skill  # URL form also works
```

**Note:** A bare slug like `letta skills install nano-banana-pro` will NOT resolve through ClawHub — you must include the `clawhub/` or `clawhub:` prefix.

### 3. GitHub Repositories

Any GitHub repository containing a `SKILL.md` can be installed directly.

```bash
# Full repo (installs from repo root)
letta skills install https://github.com/owner/repo

# Subdirectory (tree URL)
letta skills install https://github.com/owner/repo/tree/main/path/to/skill

# SKILL.md blob URL (installs parent directory)
letta skills install https://github.com/owner/repo/blob/main/path/to/skill/SKILL.md

# Shorthand: owner/repo/path
letta skills install owner/repo/path/to/skill
```

### 4. Letta & Anthropic Community Repos

| Repository | Description |
|------------|-------------|
| https://github.com/letta-ai/skills | Community skills for Letta agents |
| https://github.com/anthropics/skills | Anthropic's official Agent Skills |

These can be installed via the GitHub URL forms above, or manually cloned and copied.

## The `letta skills install` Command

The CLI handles downloading, placing the skill in the agent's memory, and committing the change:

```bash
letta skills install <source> [--agent <id> | -n <agent-name>] [--force]
```

| Flag | Purpose |
|------|---------|
| `--agent <id>` | Install into a specific agent's memfs |
| `-n <name>` | Resolve agent by name instead of id |
| `--force` | Replace an existing skill with the same name |

If no agent is specified, the command uses `LETTA_AGENT_ID` / `AGENT_ID` from the environment, or prompts interactively.

Also available as a top-level alias: `letta install <source>`.

**Managing installed skills:**

```bash
letta skills list [--agent <id>]
letta skills delete <skill-name> --agent <id>
```

## Installation Locations

When using `letta skills install`, skills are placed in the agent's memfs at `<memory-dir>/skills/<skill-name>/`.

For manual installation:

| Location | Path | When to Use |
|----------|------|-------------|
| **Agent-scoped** | `~/.letta/agents/<agent-id>/memory/skills/<skill>/` | Skills for a single agent (default) |
| **Global** | `~/.letta/skills/<skill>/` | General-purpose skills useful across projects |
| **Project** | `.skills/<skill>/` | Project-specific skills |

**Rule**: Default to **agent-scoped**. Use **project** for repo-specific skills. Use **global** only if all agents should inherit the skill.

## Manual Download (When CLI Install Isn't Available)

Skills are directories containing SKILL.md and optionally scripts/, references/, examples/.

```bash
# Clone, copy, cleanup
git clone --depth 1 https://github.com/anthropics/skills /tmp/skills-temp
cp -r /tmp/skills-temp/skills/webapp-testing ~/.letta/agents/<agent-id>/memory/skills/
rm -rf /tmp/skills-temp
```

## Registering New Skills

After installing (via CLI or manual copy), skills are automatically discovered on the next message. Skills are discovered from `~/.letta/skills/`, `.skills/`, and agent-scoped `~/.letta/agents/<agent-id>/memory/skills/` directories.

## Search Strategy

When looking for a skill to solve a user's problem:

1. **Search Hermes Skills Hub first** — `hermes skills search <query>` searches 88k+ skills across all registries. If Hermes CLI isn't available, browse the official optional-skills on GitHub (finance, mlops, blockchain, devops, research, creative, security, etc.).
2. **Search ClawHub** — community registry with versioning. Use `clawhub search` or the web UI.
3. **Search GitHub** — look for repos with `SKILL.md` files. Try `github.com/letta-ai/skills` and `github.com/anthropics/skills` first.
4. **Ask the user** — they may know of a specific skill repo or have preferences about sources.

## Complete Example

User asks: "Can you help me track stock prices?"

1. **Recognize opportunity**: Stock/finance data - Hermes has a stocks skill
2. **Ask user**: "Hermes has an official stocks skill that covers quotes, history, search, and crypto via Yahoo. Want me to install it?"
3. **If user agrees, install**:
   ```bash
   letta skills install official/finance/stocks
   ```
4. **Invoke**: `Skill(skill: "stocks")`
5. **Use**: Follow the skill's instructions for the user's task

User asks: "Can you generate images with Nano Banana Pro?"

1. **Recognize opportunity**: Image generation skill on ClawHub
2. **Ask user**: "There's a nano-banana-pro skill on ClawHub. Want me to install it?"
3. **Install**:
   ```bash
   letta skills install clawhub/nano-banana-pro
   ```
4. **Invoke**: `Skill(skill: "nano-banana-pro")`
