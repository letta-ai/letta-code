---
name: acquiring-skills
description: Guide for safely discovering and installing skills from external repositories. Use when a user asks for something where a specialized skill likely exists (browser testing, PDF processing, document generation, etc.) and you want to bootstrap your understanding rather than starting from scratch.
---

# Acquiring New Skills

This skill teaches you how to safely discover and install skills from external sources.

## SAFETY - READ THIS FIRST

Skills can contain:
- **Markdown files** (.md) - Risk: prompt injection, misleading instructions
- **Scripts** (Python, TypeScript, Bash) - Risk: malicious code execution

### Trusted Sources (no user approval needed for download)
- `https://github.com/letta-ai/skills` - Letta's community skills
- `https://github.com/anthropics/skills` - Anthropic's official skills

### Untrusted Sources (ALWAYS verify with user)
For ANY source other than letta-ai or anthropics:
1. Ask the user before downloading
2. Explain where the skill comes from
3. Get explicit approval

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

> "This sounds like something where a community skill might help (e.g., webapp testing with Playwright). Would you like me to look for available skills in the Letta or Anthropic repositories? This might take a minute, or I can start coding right away if you prefer."

The user may prefer to start immediately rather than wait for skill discovery.

Only proceed with skill acquisition if the user agrees.

## Skill Repositories

| Repository | Description |
|------------|-------------|
| https://github.com/letta-ai/skills | Community skills for Letta agents |
| https://github.com/anthropics/skills | Anthropic's official Agent Skills |

Browse these repositories to discover available skills. Check the README for skill listings.

## Installation Locations

| Location | Path | When to Use |
|----------|------|-------------|
| **Agent-scoped** | `~/.letta/agents/<agent-id>/skills/<skill>/` | Skills for a single agent (default for agent-specific capabilities) |
| **Global** | `~/.letta/skills/<skill>/` | General-purpose skills useful across projects |
| **Project** | `.skills/<skill>/` | Project-specific skills |

**Rule**: Default to **agent-scoped** for changes that should apply only to the current agent. Use **project** for repo-specific skills. Use **global** only if all agents should inherit the skill.

## How to Download Skills

Skills are directories containing SKILL.md and optionally scripts/, references/, examples/.

### Method: Clone to /tmp, then copy

```bash
# 1. Clone the repo (shallow)
git clone --depth 1 https://github.com/anthropics/skills /tmp/skills-temp

# 2. Copy the skill to your skills directory
# For agent-scoped (recommended default):
cp -r /tmp/skills-temp/skills/webapp-testing ~/.letta/agents/<agent-id>/skills/
# For global:
# cp -r /tmp/skills-temp/skills/webapp-testing ~/.letta/skills/
# For project:
# cp -r /tmp/skills-temp/skills/webapp-testing .skills/

# 3. Cleanup
rm -rf /tmp/skills-temp
```

### Alternative: rsync (preserves permissions)

```bash
git clone --depth 1 https://github.com/anthropics/skills /tmp/skills-temp
rsync -av /tmp/skills-temp/skills/webapp-testing/ ~/.letta/agents/<agent-id>/skills/webapp-testing/
rm -rf /tmp/skills-temp
```

## Registering New Skills

After downloading, refresh the skills list:

```
Skill(command: "refresh")
```

This scans `~/.letta/skills/` and `.skills/` and updates your `skills` memory block.
Agent-scoped skills under `~/.letta/agents/<agent-id>/skills/` are included in the scan as well.

## Complete Example

User asks: "Can you help me test my React app's UI?"

1. **Recognize opportunity**: Browser/webapp testing - likely has a skill
2. **Ask user**: "Would you like me to look for webapp testing skills, or start coding right away?"
3. **If user agrees, find skill**: Check anthropics/skills for webapp-testing
4. **Download** (trusted source):
   ```bash
   git clone --depth 1 https://github.com/anthropics/skills /tmp/skills-temp
   cp -r /tmp/skills-temp/skills/webapp-testing ~/.letta/agents/<agent-id>/skills/
   rm -rf /tmp/skills-temp
   ```
5. **Refresh**: `Skill(command: "refresh")`
6. **Inspect scripts**: Read any .py or .ts files before using them
7. **Load**: `Skill(command: "load", skills: ["webapp-testing"])`
8. **Use**: Follow the skill's instructions for the user's task
