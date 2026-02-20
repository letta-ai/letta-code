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

When memfs is enabled, the Letta Code CLI automatically:

1. Adds the `git-memory-enabled` tag to the agent (triggers backend to create the git repo)
2. Clones the repo into `~/.letta/agents/<agent-id>/memory/` (git root is the memory directory)
3. Configures a **local** credential helper in `memory/.git/config` (so `git push`/`git pull` work without auth ceremony)
4. Installs a **pre-commit hook** that validates frontmatter before each commit (see below)
5. On subsequent startups: pulls latest changes, reconfigures credentials and hook (self-healing)
6. During sessions: periodically checks `git status` and reminds you (the agent) to commit/push if dirty

If any of these steps fail, you can replicate them manually using the sections below.

## Authentication (Preferred: Repo-Local)

The harness configures a **per-repo** credential helper during clone and refreshes it on pull/startup.
This local setup is the default and recommended approach.

Why this matters: host-level **global** credential helpers (e.g. installed by other tooling) can conflict with memfs auth and cause confusing failures.

**Important:** Always use **single-line** format for credential helpers. Multi-line helpers can break tools that parse `git config --list` line-by-line.

```bash
cd ~/.letta/agents/<agent-id>/memory

# Check local helper(s)
git config --local --get-regexp '^credential\..*\.helper$'

# Reconfigure local helper (e.g. after API key rotation) - SINGLE LINE
git config --local credential.$LETTA_BASE_URL.helper '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'
```

If you suspect global helper conflicts, inspect and clear host-specific global entries:

```bash
# Inspect Letta-related global helpers
git config --global --get-regexp '^credential\..*letta\.com.*\.helper$'

# Example: clear a conflicting host-specific helper
git config --global --unset-all credential.https://api.letta.com.helper
```

For cloning a *different* agent's repo, prefer a one-off auth header over global credential changes:

```bash
AUTH_HEADER="Authorization: Basic $(printf 'letta:%s' "$LETTA_API_KEY" | base64 | tr -d '\n')"
git -c "http.extraHeader=$AUTH_HEADER" clone "$LETTA_BASE_URL/v1/git/<agent-id>/state.git" ~/my-agent-memory
```

## Pre-Commit Hook (Frontmatter Validation)

The harness installs a git pre-commit hook that validates `.md` files under `memory/` before each commit. This prevents pushes that the server would reject.

**Rules:**
- Every `.md` file must have YAML frontmatter (`---` header and closing `---`)
- Required fields: `description` (non-empty string), `limit` (positive integer)
- `read_only` is a **protected field**: you (the agent) cannot add, remove, or change it. Files with `read_only: true` cannot be modified at all. Only the server/user sets this field.
- Unknown frontmatter keys are rejected

**Valid file format:**
```markdown
---
description: What this block contains
limit: 20000
---

Block content goes here.
```

If the hook rejects a commit, read the error message — it tells you exactly which file and which rule was violated. Fix the file and retry.

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
MEMORY_REPO_DIR="$AGENT_DIR/memory"

# 1. Add git-memory-enabled tag (IMPORTANT: preserve existing tags!)
# First GET the agent to read current tags, then PATCH with the new tag appended.
# The harness code does: tags = [...existingTags, "git-memory-enabled"]
curl -X PATCH "$LETTA_BASE_URL/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["origin:letta-code", "git-memory-enabled"]}'

# 2. Clone the repo into memory/
mkdir -p "$MEMORY_REPO_DIR"
git clone "$LETTA_BASE_URL/v1/git/$AGENT_ID/state.git" "$MEMORY_REPO_DIR"

# 3. Configure local credential helper (single-line format required)
cd "$MEMORY_REPO_DIR"
git config --local credential.$LETTA_BASE_URL.helper '!f() { echo "username=letta"; echo "password=$LETTA_API_KEY"; }; f'
```

## Bidirectional Sync

### API Edit -> Git Pull

```bash
# 1. Edit block via API (or use memory tools)
# 2. Pull to get changes (webhook creates commit automatically)
cd ~/.letta/agents/<agent-id>/memory
git pull
```

Changes made via the API are automatically committed to git within 2-3 seconds.

### Git Push -> API Update

```bash
cd ~/.letta/agents/<agent-id>/memory

# 1. Edit files locally
echo "Updated info" > system/human.md

# 2. Commit and push
git add system/human.md
git commit -m "fix: update human block"
git push

# 3. API automatically reflects changes (webhook-triggered, ~2-3s delay)
```

## Conflict Resolution

When both API and git have diverged:

```bash
cd ~/.letta/agents/<agent-id>/memory

# 1. Try to push (will be rejected)
git push  # -> "fetch first"

# 2. Pull to create merge conflict
git pull --no-rebase
# -> CONFLICT in system/human.md

# 3. View conflict markers
cat system/human.md
# <<<<<<< HEAD
# your local changes
# =======
# server changes
# >>>>>>> <commit>

# 4. Resolve
echo "final resolved content" > system/human.md
git add system/human.md
git commit -m "fix: resolved conflict in human block"

# 5. Push resolution
git push
# -> API automatically updates with resolved content
```

## Block Management

### Create New Block

```bash
# Create file in system/ directory (automatically attached to agent)
echo "My new block content" > system/new-block.md
git add system/new-block.md
git commit -m "feat: add new block"
git push
# -> Block automatically created and attached to agent
```

### Delete/Detach Block

```bash
# Remove file from system/ directory
git rm system/persona.md
git commit -m "chore: remove persona block"
git push
# -> Block automatically detached from agent
```

## Directory Structure

```
~/.letta/agents/<agent-id>/
├── .letta/
│   └── config.json              # Agent metadata
└── memory/                      # Git repo root
    ├── .git/                    # Git repo data
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
- Check local helper(s): `git -C ~/.letta/agents/<agent-id>/memory config --local --get-regexp '^credential\..*\.helper$'`
- Check for conflicting global helper(s): `git config --global --get-regexp '^credential\..*letta\.com.*\.helper$'`
- Reconfigure local helper: see Authentication section above
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
