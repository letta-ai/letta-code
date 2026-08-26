---
name: syncing-memory-filesystem
description: Diagnose and repair MemFS repository setup, remote sync, authentication failures, optional backup remotes, or merge/rebase conflicts. Do not load for routine memory reads or edits.
---

# MemFS Repository Repair

Use this skill only when the Git repository behind an agent's memory is not
setting up or syncing correctly. For ordinary memory reads and edits, use the
memory files or the memory tools without loading this skill.

## Current Model

MemFS is a Git repository projected onto the computer where the agent is
running. `$MEMORY_DIR` is the repository root. There is no second `memory/`
directory inside it.

```text
$MEMORY_DIR/
├── .git/
├── system/       # loaded into the system prompt
├── reference/    # loaded only when read
└── skills/       # agent-owned skills
```

Cloud-backed agents have a hosted MemFS remote. Local-backend agents keep a
local-only Git repository and do not need a remote or cloud credentials.

The memory tools commit their changes. After each turn, the harness pushes
clean committed changes for cloud-backed agents. Local-backend commits remain
on the current machine. Do not run `git push` for normal MemFS sync; let the
harness push after the turn.

Committed memory changes do not alter the current compiled prompt immediately.
Use `/recompile` when the current conversation must see new `system/` content
right away. Otherwise, the next prompt compilation or conversation will use
the committed revision.

## Start With the Harness

Prefer the harness commands over manual API calls, remote construction, or
credential-helper edits:

```text
/memfs status    # show whether MemFS is enabled and its path
/memfs enable    # initialize or repair MemFS setup
/memfs sync      # pull the hosted repository
```

From a shell, the standalone status and pull commands are:

```bash
letta memory status --agent "$AGENT_ID"
letta memory pull --agent "$AGENT_ID"
```

`letta memory pull` is a no-op for a local-backend agent because there is no
hosted remote.

Do not reproduce `/memfs enable` by PATCHing agent tags or constructing a Git
remote by hand. The enable flow also updates the system prompt mode, recompiles
the agent, persists local settings, detaches legacy memory tools, preserves and
adds tags, initializes the checkout, installs hooks, configures identity, and
seeds default memory files.

## Inspect a Broken Checkout

Use `$MEMORY_DIR` instead of a hard-coded `~/.letta/agents/...` path. Local and
cloud-backed agents use different parent directories.

```bash
git -C "$MEMORY_DIR" status --short --branch
git -C "$MEMORY_DIR" remote get-url origin | sed -E 's#(https?://)[^/@]+@#\1<redacted>@#'
git -C "$MEMORY_DIR" log -5 --oneline
```

Do not print credential-helper values or tokens. Do not change global Git
configuration. The harness installs or refreshes repository-local auth during
clone and pull when the active transport supports a persistent helper. Desktop
may instead use a temporary Git transport proxy and intentionally omit the
persistent helper.

If the checkout is missing `.git/`, use `/memfs enable`. If it exists but is
behind, use `/memfs sync` or `letta memory pull --agent "$AGENT_ID"`. Pull also
repairs recognized stale MemFS origin URLs and refreshes repository-local hooks,
auth, branch tracking, and agent identity.

## Uncommitted Changes

Raw file edits must preserve required frontmatter. Markdown files under
`system/` and `reference/` need a non-empty `description`. `read_only` is
protected and cannot be added, removed, or changed by the agent.

```markdown
---
description: What this memory file contains
---

Memory content goes here.
```

Review the complete diff before committing. Stage named memory files only and
create a new commit. Once the repository is clean, the harness will push a
cloud-backed agent's pending commits after the turn.

## Merge or Rebase Conflicts

The harness first tries a fast-forward pull. When a remote push is rejected
because the remote moved, post-turn sync tries `git pull --rebase` and retries
the push. If that rebase conflicts, the harness leaves the repository for
manual resolution and reports the affected files.

Start by reading the current Git operation and every conflicted file:

```bash
git -C "$MEMORY_DIR" status
git -C "$MEMORY_DIR" diff --name-only --diff-filter=U
```

Resolve the conflict markers without deleting required frontmatter, then stage
the resolved files by name. Finish the operation Git reports:

```bash
git -C "$MEMORY_DIR" add system/example.md

# If git status says a rebase is in progress:
GIT_EDITOR=true git -C "$MEMORY_DIR" rebase --continue

# If git status says a merge is in progress:
git -C "$MEMORY_DIR" commit
```

Do not start a new merge when a rebase is already in progress. Do not reset,
abort, or discard either side without the user's approval. When the repository
is clean and the merge or rebase is complete, the harness retries the hosted
push after a future turn.

## Optional Backup Remote

`/memory-repository` mirrors the agent's `main` branch to an additional Git
URL. This is separate from the hosted MemFS origin.

```text
/memory-repository set git@github.com:you/my-memory.git
/memory-repository status
/memory-repository push
/memory-repository unset
```

`set` stores `letta.memoryRepository.url` in the MemFS repository's local Git
config, installs the post-commit hook, and attempts an initial push. Later
commits on `main` start a background mirror push. Mirror failures do not block
the commit; `/memory-repository status` shows the recent push log.

Use normal SSH or Git credential handling for the backup URL. Avoid embedding a
token in the URL because the URL is stored in `.git/config`. Use
`/memory-repository push` only for this optional backup remote, not for normal
MemFS synchronization.

## Failure Checklist

1. Confirm `$MEMORY_DIR` points to the active agent's repository.
2. Check whether the backend is cloud-backed or local-only.
3. Inspect `git status`, the origin URL, and the current Git operation.
4. Use `/memfs enable` for a missing checkout and `/memfs sync` for a pull.
5. Preserve frontmatter and finish any existing merge or rebase.
6. Leave hosted pushes to post-turn sync once the repository is clean.
7. If the command still fails, rerun it with `LETTA_DEBUG=1` and report the
   redacted error. Never print or copy credential-helper values.
