---
name: managing-shared-memory
description: Create and manage shared memory — git-tracked repositories hosted on Letta Cloud that are attached to one or more agents and projected into their filesystems. Use when the user wants to share memory or files across agents, store context outside your own MemFS, attach or detach shared memory, or inspect its file history.
---

# Managing Shared Memory

Shared memory is memory created independently of any single agent, designed to be dynamically attached to or detached from multiple agents. Each unit of shared memory is a **shared memory repository**: a git repository hosted on Letta Cloud, owned by your organization rather than by one agent, reachable from any environment (sandboxes, remote machines, sessions).

Shared memory works exactly like your MemFS: attached repositories are real git checkouts on disk, and you read, edit, commit, and push them with ordinary git. The only differences are that each repository has its own projection root (next to your memory directory, not inside it) and its own remote origin, and other agents may be writing to it too.

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

Edit files with your normal file tools, then commit and push with git — the mount's origin and credentials are already configured:

```bash
cd "$MEMORY_DIR/../<repo-name>"
git add <files>
git commit -m "describe the change"
git push
```

Unlike MemFS, the harness does not auto-push shared memory after turns — a commit you don't push is not visible to other agents or environments. Always push after committing.

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
- **Push rejected (non-fast-forward)** — another agent pushed first: `git pull --rebase`, resolve any conflicts, push again.

## Notes and Limits

- Shared memory is not part of your system prompt. Writing to it does not change your in-context memory — for that, edit your memory blocks or MemFS files.
- Attaching is asynchronous on the server; `letta shared-memory attach` waits for the attachment to be visible before cloning.
- SDK/API equivalent for programmatic callers: `@letta-ai/letta-agent-sdk` exposes these operations as `client.repositories` (with `files` and `versions` helpers), and shared memory can be attached for a session's lifetime via `resources: [{ type: "repository", repositoryId }]` on cloud sessions. The REST resource is `/v1/repositories`.
