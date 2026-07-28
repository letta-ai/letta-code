---
name: managing-shared-memory
description: Create and manage shared memory — git-tracked repositories hosted on Letta Cloud that are attached to one or more agents and projected into their filesystems. Use when the user wants to share memory or files across agents, store context outside your own MemFS, attach or detach shared memory, or inspect its file history.
---

# Managing Shared Memory

Shared memory is memory created independently of any single agent, designed to be dynamically attached to or detached from multiple agents. Each unit of shared memory is a **shared memory repository**: a git-tracked filesystem hosted on Letta Cloud, owned by your organization rather than by one agent, reachable from any environment (sandboxes, remote machines, sessions).

Like the rest of your external memory, shared memory lives outside your system prompt — it is not in-context. Unlike the rest of your external memory, it is not scoped to *you* specifically, so each attached repository has its own local projection root and its own remote git origin, separate from your MemFS.

Create a shared memory repository when:
- You have context an agent should be able to access that doesn't belong in its own MemFS (input files, datasets, docs, working artifacts)
- Multiple agents need to read or write the same context
- You want a versioned file store that survives across environments and sessions

Every file change is a git commit, so history is always available.

## Accessing Attached Shared Memory

When shared memory is attached to you and you're running in a cloud sandbox/environment, it is projected on disk next to your memory directory — each repository at its own projection root:

```bash
ls "$MEMORY_DIR/../"           # attached shared memory appears here by name
cat "$MEMORY_DIR/../<repo-name>/<path>"
```

If you don't see an expected repository on disk, fall back to the API (below) — it always works regardless of environment.

## API Operations

Shared memory repositories are the `repositories` resource in the Letta API. All operations go through the API using `$LETTA_API_KEY` via the Bash tool. Use `https://api.letta.com` (or `$LETTA_BASE_URL` if set — e.g. when running under Letta Desktop, which proxies auth). Responses are JSON.

```bash
BASE="${LETTA_BASE_URL:-https://api.letta.com}"
AUTH="Authorization: Bearer $LETTA_API_KEY"
```

### Repositories

```bash
# Create
curl -sS -X POST "$BASE/v1/repositories" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name": "shared-inputs"}'
# → {"id": "repo-...", "name": "shared-inputs", "created_at": ..., "updated_at": ...}

# List (paginated)
curl -sS "$BASE/v1/repositories?limit=50&offset=0" -H "$AUTH"
# → {"repositories": [...], "has_next_page": false}

# Get one
curl -sS "$BASE/v1/repositories/{repository_id}" -H "$AUTH"

# Delete (soft-delete)
curl -sS -X DELETE "$BASE/v1/repositories/{repository_id}" -H "$AUTH"
```

### Files

Files are text content addressed by path. Every mutation returns a `commit_sha` and the file's `content_sha256`.

```bash
# List files (optional: path_prefix, depth, ref)
curl -sS "$BASE/v1/repositories/{repository_id}/files?path_prefix=docs/&depth=2" -H "$AUTH"
# → {"files": [{"path": "docs/a.md", "type": "file"}, ...], "ref": "<sha>"}

# Create
curl -sS -X POST "$BASE/v1/repositories/{repository_id}/files" -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"path": "docs/a.md", "content": "hello"}'

# Read (optional: ref for a historical version)
curl -sS "$BASE/v1/repositories/{repository_id}/files/content?path=docs/a.md" -H "$AUTH"
# → {"path": "docs/a.md", "content": "hello", "content_sha256": "...", "ref": "..."}

# Update content and/or rename. The optional precondition fails the write
# if the file changed since you last read it (use when multiple agents write).
curl -sS -X POST "$BASE/v1/repositories/{repository_id}/files/content" -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/a.md",
    "content": "updated",
    "new_path": "docs/b.md",
    "precondition": {"type": "content_sha256", "content_sha256": "<sha from last read>"}
  }'

# Delete
curl -sS -X DELETE "$BASE/v1/repositories/{repository_id}/files/content" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"path": "docs/b.md"}'
# → {"success": true, "commit_sha": "..."}
```

### Version History

```bash
# List commits (optionally scoped to one path)
curl -sS "$BASE/v1/repositories/{repository_id}/versions?path=docs/a.md&limit=20" -H "$AUTH"
# → {"commits": [{"sha": "...", "message": "...", "timestamp": "...", "author_name": ...}]}

# Read a file as of a specific commit
curl -sS "$BASE/v1/repositories/{repository_id}/versions/{sha}?path=docs/a.md" -H "$AUTH"
```

### Attaching Shared Memory to Agents

Attaching projects the repository into the agent's environments; detaching removes it. Neither changes the agent's own MemFS.

```bash
# List shared memory attached to an agent
curl -sS "$BASE/v1/agents/{agent_id}/repositories" -H "$AUTH"

# Attach
curl -sS -X POST "$BASE/v1/agents/{agent_id}/repositories" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"repository_id": "repo-..."}'

# Detach
curl -sS -X DELETE "$BASE/v1/agents/{agent_id}/repositories/{repository_id}" -H "$AUTH"
```

Attaching is asynchronous — after a POST, poll the list endpoint until the repository appears before relying on it. You can attach shared memory to yourself (`$AGENT_ID`) or to another agent to share context with it.

## Notes and Limits

- Shared memory files are **text** content; binary files are not supported via the files API.
- Attached shared memory is not scoped to you — another agent may edit the same files at any time. Use the `content_sha256` precondition on updates when multiple agents may write the same file; on failure, re-read and retry.
- Shared memory is not part of your system prompt. Writing to it does not change your in-context memory — for that, edit your memory blocks or MemFS files.
- SDK equivalent: `@letta-ai/letta-agent-sdk` exposes these operations as `client.repositories` (with `files` and `versions` helpers) and supports attaching shared memory for a session's lifetime via `resources: [{ type: "repository", repositoryId }]` on cloud sessions.
