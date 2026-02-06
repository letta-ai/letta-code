---
name: syncing-memory-filesystem
description: Manage git-backed memory repos. Load this skill when working with git-backed agent memory, setting up remote memory repos, resolving sync conflicts, or managing memory via git workflows.
---

# Git-Backed Memory Repos

Agents with the `git-memory-enabled` tag have their memory blocks stored in git repositories accessible via the Letta API. This enables version control, collaboration, and external editing of agent memory.

**Features:**
- Stored in cloud (GCS)
- Accessible via `https://api.letta.com/v1/git/<agent-id>/state.git`
- Bidirectional sync: API ↔ Git (webhook-triggered, ~2-3s delay)
- Structure: `memory/system/*.md` for system blocks

## Setup Authentication (One-Time)

Configure git credential helper to authenticate with Letta API:

```bash
export LETTA_API_KEY="your-api-key"

git config --global credential.https://api.letta.com.helper '!f() { 
  echo "username=letta"; 
  echo "password=$LETTA_API_KEY"; 
}; f'
```

After setup, git operations will automatically use your API key for authentication.

## Clone Agent Memory

```bash
# Clone agent's memory repo
git clone "https://api.letta.com/v1/git/<agent-id>/state.git" ~/my-agent-memory

# View memory blocks
ls ~/my-agent-memory/memory/system/
cat ~/my-agent-memory/memory/system/human.md
```

## Bidirectional Sync

### API Edit → Git Pull

```bash
# 1. Edit block via API (or use memory tools)
# 2. Pull to get changes (webhook creates commit automatically)
cd ~/my-agent-memory
git pull --ff-only
```

Changes made via the API are automatically committed to git within 2-3 seconds.

### Git Push → API Update

```bash
# 1. Edit files locally
echo "Updated info" > memory/system/human.md

# 2. Commit and push
git add memory/system/human.md
git commit -m "update human block"
git push

# 3. API automatically reflects changes (webhook-triggered, ~2-3s delay)
```

Changes pushed to git are automatically synced to the API within 2-3 seconds.

## Conflict Resolution

When both API and git have diverged:

```bash
cd ~/my-agent-memory

# 1. Try to push (will be rejected)
git push  # → "fetch first"

# 2. Pull to create merge conflict
git pull --no-rebase
# → CONFLICT in memory/system/human.md

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
git commit -m "resolved conflict"

# 5. Push resolution
git push
# → API automatically updates with resolved content
```

## Block Management

### Create New Block

```bash
# Create file in system/ directory (automatically attached to agent)
echo "My new block content" > memory/system/new-block.md
git add memory/system/new-block.md
git commit -m "add new block"
git push
# → Block automatically created and attached to agent
```

### Delete/Detach Block

```bash
# Remove file from system/ directory
git rm memory/system/persona.md
git commit -m "remove persona block"
git push
# → Block automatically detached from agent
```

## Directory Structure

```
repo/
├── .letta/
│   └── config.json          # Repo metadata
└── memory/
    └── system/              # System blocks (attached to agent)
        ├── human.md
        └── persona.md
```

**System blocks** (`memory/system/`) are attached to the agent and appear in the agent's memory.

## Requirements

- Agent must have `git-memory-enabled` tag
- Valid API key with agent access
- Git installed locally

## Troubleshooting

**Clone fails with "Authentication failed":**
- Verify credential helper is set: `git config --global --get credential.https://api.letta.com.helper`
- Verify API key is exported: `echo $LETTA_API_KEY`
- Reconfigure: Run setup command again with your API key

**Push/pull doesn't update API:**
- Wait 2-3 seconds for webhook processing
- Verify agent has `git-memory-enabled` tag
- Check if you have write access to the agent

**Can't see changes immediately:**
- Bidirectional sync has a 2-3 second delay for webhook processing
- Use `git pull` to get latest API changes
- Use `git fetch` to check remote without merging
