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

## What the CLI Harness Does

The Letta Code CLI automatically handles initial setup. Understanding this lets you self-repair or replicate the behavior manually if needed.

### On `/memfs enable`:
1. Adds the `git-memory-enabled` tag to the agent (triggers backend to create the git repo and add `system/` prefix to block labels)
2. Clones the repo from `$LETTA_BASE_URL/v1/git/<agent-id>/state.git` into `~/.letta/agents/<agent-id>/`
3. Configures a **local credential helper** in `.git/config` so plain `git push`/`git pull` work without auth prefixes
4. Updates the `memory_filesystem` block with the directory tree

### On startup (when memfs is already enabled):
1. If no `.git/` directory exists, clones the repo (same as enable)
2. If `.git/` exists, runs `git pull` (fast-forward, falls back to rebase)
3. Re-configures the credential helper (self-healing if config was lost)
4. Updates the `memory_filesystem` block

### During a session:
- Periodically checks `git status` and `git rev-list @{u}..HEAD`
- If there are uncommitted changes or unpushed commits, injects a system reminder prompting you to commit and push

### Manual replication:
If the harness setup fails or you need to do it yourself:

```bash
AGENT_ID="<your-agent-id>"
AGENT_DIR=~/.letta/agents/$AGENT_ID

# 1. Add the git-memory-enabled tag (triggers backend to create git repo)
curl -X PATCH "$LETTA_BASE_URL/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["git-memory-enabled"]}'
# NOTE: This adds the system/ prefix to block labels and creates the repo.
# If the agent already has other tags, include them in the array to avoid removing them.

# 2. Clone the repo
git clone "$LETTA_BASE_URL/v1/git/$AGENT_ID/state.git" "$AGENT_DIR"

# 3. Configure local credential helper (so git push/pull just work)
cd "$AGENT_DIR"
git config credential.$LETTA_BASE_URL.helper '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'

# 4. Verify
git pull   # should work without auth prompts
git status
```

## Authentication

The harness configures a **per-repo credential helper** during clone. This stores the API key in `.git/config` so you can run plain git commands:

```bash
cd ~/.letta/agents/<agent-id>
git pull    # just works
git push    # just works
```

To check if credentials are configured:
```bash
git config --get credential.$LETTA_BASE_URL.helper
```

To manually reconfigure (e.g. after API key rotation):
```bash
git config credential.$LETTA_BASE_URL.helper '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'
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

Changes pushed to git are automatically synced to the API within 2-3 seconds.

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
        ├── human/
        │   ├── personal_info.md
        │   └── prefs.md
        └── persona/
            └── soul.md
```

**System blocks** (`memory/system/`) are attached to the agent and appear in the agent's system prompt.

## Requirements

- Agent must have `git-memory-enabled` tag
- Valid API key with agent access
- Git installed locally

## Troubleshooting

**Clone fails with "Authentication failed":**
- Check local credential helper: `git config --get credential.$LETTA_BASE_URL.helper`
- Reconfigure: see "Manual replication" section above

**Push/pull doesn't update API:**
- Wait 2-3 seconds for webhook processing
- Verify agent has `git-memory-enabled` tag
- Check if you have write access to the agent

**Harness setup failed (no .git/ after enable):**
- Check debug logs (`LETTA_DEBUG=1`)
- Try manual replication steps above
- Verify the git endpoint is reachable: `curl -u letta:$LETTA_API_KEY $LETTA_BASE_URL/v1/git/<agent-id>/state.git/info/refs?service=git-upload-pack`

**Credential helper not working after restart:**
- The harness reconfigures on every pull (self-healing)
- To manually fix: `git config credential.$LETTA_BASE_URL.helper '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'`
