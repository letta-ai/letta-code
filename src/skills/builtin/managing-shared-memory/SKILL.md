---
name: managing-shared-memory
description: Create and manage shared memory — git-tracked repositories hosted on Letta Cloud that are attached to one or more agents and projected into their filesystems. Use when the user wants to share memory or files across agents, store context outside your own MemFS, attach or detach shared memory, or inspect its file history.
---

# Managing Shared Memory

Shared memory is memory created independently of any single agent, designed to be dynamically attached to or detached from multiple agents. Each unit of shared memory is a **shared memory repository**: a git repository hosted on Letta Cloud, owned by your organization rather than by one agent, reachable from any environment (sandboxes, remote machines, sessions).

Shared memory works like your MemFS: attached repositories are real git checkouts on disk, and you read, edit, and commit with ordinary git. The harness pushes clean committed changes after each turn. Each repository has its own projection root (next to your memory directory, not inside it) and its own remote origin, and other agents may be writing to it too.

Create a shared memory repository when:
- You have context an agent should be able to access that doesn't belong in its own MemFS (input files, datasets, docs, working artifacts)
- Multiple agents need to read or write the same context
- You want a versioned file store that survives across environments and sessions

## Working with Files (the normal path)

Attached shared memory is mounted next to your memory directory, one git checkout per repository:

```bash
ls "$MEMORY_DIR/../"                      # attached repositories appear here by name
cat "$MEMORY_DIR/../<repo-name>/<path>"   # read like any file
```

Edit files with your normal file tools, then commit from the mount (`cd "$MEMORY_DIR/../<repo-name>"`) using [Commit memory changes](#commit-memory-changes). The mount's origin and credentials are already configured. Other agents read this history, so the sources matter as much as in your own memory.

The harness pushes clean commits from read/write attached repositories after the turn. If a push collides with another agent's work, it pulls with rebase and retries once. Dirty files and conflicts are not changed automatically; the harness adds a reminder to the next turn instead.

To pick up other agents' changes:

```bash
git -C "$MEMORY_DIR/../<repo-name>" pull --rebase
```

If a push is rejected (another agent pushed first), `git pull --rebase` then push again.

History is ordinary git history:

```bash
git -C "$MEMORY_DIR/../<repo-name>" log --oneline -- <path>
```

## Managing Repositories (create / attach / detach)

Use the `letta shared-memory` subcommand. It uses your harness auth (works even when `LETTA_API_KEY` is not in the shell env) and inherits the agent id from `AGENT_ID`, so `--agent` is only needed when targeting another agent.

```bash
# List org repositories (marks which are attached to you)
letta shared-memory list

# Create a repository
letta shared-memory create --name shared-notes

# Attach to yourself: attaches via the API, clones the local mount at
# $MEMORY_DIR/../shared-notes, and recompiles the system prompt projection
letta shared-memory attach shared-notes

# Attach to another agent (its mount materializes in that agent's environments)
letta shared-memory attach shared-notes --agent agent-...

# Detach (leaves the local mount directory in place)
letta shared-memory detach shared-notes

# Repair/refresh mounts: clone or pull every attached repository. Use this when
# the system prompt references a repository that is missing on disk (e.g. after
# it was attached from another surface while this session was running).
letta shared-memory sync

# Commit history via the API (works even without a local mount)
letta shared-memory history shared-notes --path docs/plan.md
```

## Troubleshooting

- **Prompt lists a repository but `$MEMORY_DIR/../<name>` is missing** — the repository was attached without materializing the mount. Run `letta shared-memory sync`.
- **`sync` reports "mount path already exists and is not a git repository"** — a plain directory (usually created by hand before the mount existed) is occupying the mount path. Inspect it, salvage anything worth keeping, move or delete it, then re-run `letta shared-memory sync`.
- **Never hand-clone the repository to another location (e.g. /tmp) to work around a broken mount** — fix the mount with `letta shared-memory sync` so every session and other agents see the same checkout.
- **Permission denied under another agent's directory** — shared repositories mount per-agent. Only your own mount (under your agent directory) is accessible; another agent's mount of the same repository is walled off by the cross-agent guard. Run `letta shared-memory sync` to get your own mount.
- **Shared-memory conflict reminder** — resolve the conflict in the named repository, finish the rebase or commit, and leave the repository clean. The harness retries the push after a future turn.

## Commit memory changes

Every memory commit names where the learning came from, so `git log` holds the evidence and memory files do not. From the repository root, stage only the files you changed and commit in one shell call:

```bash
git add <changed files> && git commit -m "<type>(<scope>): <what changed>

<why: the correction, instruction, or pattern this encodes>

Sources:
- <where the learning came from>"
```

- `<type>`: `feat` adds knowledge or behavior, `fix` corrects wrong or stale memory, `chore` reorganizes without changing meaning.
- `<scope>`: the process making the change: `memory` for ordinary edits, or `init`, `doctor`, `sync`, `reflection`.
- `Sources:` lists each origin precisely enough to find again: a conversation ID (with a message ID when one message decided it), a transcript or session ID, a file path, a URL, PR, or issue, or a commit hash. When the user explicitly asked for the change, that request is a source; cite its conversation. Resolve values such as `$CONVERSATION_ID` before writing them; never commit a literal variable name.
- Do not invent a source. If the origin cannot be identified, write `Sources: unknown` and say why in the body.
- Commit messages are visible wherever the repository syncs. Never include secrets, and keep quotes and personal details to what the reason needs.

## Notes and Limits

- Shared memory is not part of your system prompt. Writing to it does not change your in-context memory — for that, edit your memory blocks or MemFS files.
- Attaching is asynchronous on the server; `letta shared-memory attach` waits for the attachment to be visible before cloning.
- SDK/API equivalent for programmatic callers: `@letta-ai/letta-agent-sdk` exposes these operations as `client.repositories` (with `files` and `versions` helpers), and shared memory can be attached for a session's lifetime via `resources: [{ type: "repository", repositoryId }]` on cloud sessions. The REST resource is `/v1/repositories`.
