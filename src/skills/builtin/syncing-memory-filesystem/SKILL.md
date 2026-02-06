---
name: syncing-memory-filesystem
description: Manage git-backed memory repos. Load this skill when working with git-backed agent memory, setting up remote memory repos, resolving sync conflicts, or managing memory via git workflows.
---

# Git-Backed Memory Repos

Agents with the `git-memory-enabled` tag have their memory blocks stored in git repositories accessible via the Letta API. This enables version control, collaboration, and external editing of agent memory.

**Features:**
- Stored in cloud (GCS)
- Accessible via `$LETTA_BASE_URL/v1/git/<agent-id>/state.git`
- Bidirectional sync: API <-> Git (webhook-triggered, ~2-3s delay)
- Structure: `memory/system/*.md` for system blocks

## What the CLI Harness Does Automatically

The Letta Code CLI handles initial setup when you run `/memfs enable`:

1. Adds the `git-memory-enabled` tag to the agent (triggers backend to create the git repo)
2. Clones the repo into `~/.letta/agents/<agent-id>/`
3. Configures a **local** credential helper in `.git/config` (so `git push`/`git pull` work without auth ceremony)
4. On subsequent startups: pulls latest changes and reconfigures credentials (self-healing)
5. During sessions: periodically checks `git status` and reminds you to commit/push if dirty

If any of these steps fail, you can replicate them manually using the sections below.

## Authentication

The harness configures a per-repo credential helper during clone. To verify or reconfigure:

```bash
cd ~/.letta/agents/<agent-id>

# Check if configured
git config --get credential.$LETTA_BASE_URL.helper

# Reconfigure (e.g. after API key rotation)
git config credential.$LETTA_BASE_URL.helper \
  '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'
```

For cloning a *different* agent's repo (e.g. during memory migration), set up a global helper:

```bash
git config --global credential.$LETTA_BASE_URL.helper \
  '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'
```

## Clone Agent Memory

```bash
# Clone agent's memory repo
git clone "$LETTA_BASE_URL/v1/git/<agent-id>/state.git" ~/my-agent-memory

# View memory blocks
ls ~/my-agent-memory/memory/system/
cat ~/my-agent-memory/memory/system/human.md
```

## Enabling Git Memory (Manual)

If the harness `/memfs enable` failed, you can replicate it:

```bash
AGENT_ID="<your-agent-id>"
AGENT_DIR=~/.letta/agents/$AGENT_ID

# 1. Add git-memory-enabled tag (IMPORTANT: preserve existing tags!)
# First GET the agent to read current tags, then PATCH with the new tag appended.
# The harness code does: tags = [...existingTags, "git-memory-enabled"]
curl -X PATCH "$LETTA_BASE_URL/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["origin:letta-code", "git-memory-enabled"]}'

# 2. Clone the repo
git clone "$LETTA_BASE_URL/v1/git/$AGENT_ID/state.git" "$AGENT_DIR"

# 3. Configure local credential helper
cd "$AGENT_DIR"
git config credential.$LETTA_BASE_URL.helper \
  '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'
```

## Bidirectional Sync

### API Edit -> Git Pull

```bash
# 1. Edit block via API (or use memory tools)
# 2. Pull to get changes (webhook creates commit automatically)
cd ~/.letta/agents/<agent-id>
git pull
```

Changes made via the API are automatically committed to git within 2-3 seconds.

### Git Push -> API Update

```bash
cd ~/.letta/agents/<agent-id>

# 1. Edit files locally
echo "Updated info" > memory/system/human.md

# 2. Commit and push
git add memory/system/human.md
git commit -m "fix: update human block"
git push

# 3. API automatically reflects changes (webhook-triggered, ~2-3s delay)
```

## Conflict Resolution

When both API and git have diverged:

```bash
cd ~/.letta/agents/<agent-id>

# 1. Try to push (will be rejected)
git push  # -> "fetch first"

# 2. Pull to create merge conflict
git pull --no-rebase
# -> CONFLICT in memory/system/human.md

# 3. View conflict markers
cat memory/system/human.md
# <<<<<<< HEAD
# your local changes
# =======
# server changes
# >>>>>>> <commit>

# 4. Resolve
echo "final resolved content" > memory/system/human.md
git add memory/system/human.md
git commit -m "fix: resolved conflict in human block"

# 5. Push resolution
git push
# -> API automatically updates with resolved content
```

## Block Management

### Create New Block

```bash
# Create file in system/ directory (automatically attached to agent)
echo "My new block content" > memory/system/new-block.md
git add memory/system/new-block.md
git commit -m "feat: add new block"
git push
# -> Block automatically created and attached to agent
```

### Delete/Detach Block

```bash
# Remove file from system/ directory
git rm memory/system/persona.md
git commit -m "chore: remove persona block"
git push
# -> Block automatically detached from agent
```

## Directory Structure

```
~/.letta/agents/<agent-id>/
├── .git/                        # Git repo data
├── .letta/
│   └── config.json              # Repo metadata
└── memory/
    └── system/                  # System blocks (attached to agent)
        ├── human.md
        └── persona.md
```

**System blocks** (`memory/system/`) are attached to the agent and appear in the agent's system prompt.

## Requirements

- Agent must have `git-memory-enabled` tag
- Valid API key with agent access
- Git installed locally

## Troubleshooting

**Clone fails with "Authentication failed":**
- Check credential helper: `git config --get credential.$LETTA_BASE_URL.helper`
- Reconfigure: see Authentication section above
- Verify the endpoint is reachable: `curl -u letta:$LETTA_API_KEY $LETTA_BASE_URL/v1/git/<agent-id>/state.git/info/refs?service=git-upload-pack`

**Push/pull doesn't update API:**
- Wait 2-3 seconds for webhook processing
- Verify agent has `git-memory-enabled` tag
- Check if you have write access to the agent

**Harness setup failed (no .git/ after /memfs enable):**
- Check debug logs (`LETTA_DEBUG=1`)
- Follow "Enabling Git Memory (Manual)" steps above

**Can't see changes immediately:**
- Bidirectional sync has a 2-3 second delay for webhook processing
- Use `git pull` to get latest API changes
- Use `git fetch` to check remote without merging
