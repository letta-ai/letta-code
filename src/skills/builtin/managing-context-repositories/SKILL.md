---
name: managing-context-repositories
description: Create and manage shared context repositories — git-tracked remote filesystems hosted on Letta Cloud that can be attached to agents and accessed across environments. Use when the user wants to share context or files across agents, store data outside MemFS, attach a repository to an agent, or inspect repository file history.
---

# Managing Context Repositories

Context repositories are **shared memory for agents**: git-tracked, remote filesystems hosted on Letta Cloud. They are owned by your organization, not by any single agent, and can be attached to multiple agents and accessed from any environment (sandboxes, remote machines, sessions).

Create a repository when:
- You have data an agent should be able to access that doesn't belong in its MemFS (input files, datasets, docs, working artifacts)
- Multiple agents need to share the same context
- You want a versioned file store that survives across environments and sessions

Unlike MemFS, a context repository is not part of any agent's memory or system prompt — it's an external, shared filesystem. Every file change is a git commit, so history is always available.

## Accessing an Attached Repository

When a repository is attached to you and you're running in a cloud sandbox/environment, its contents are materialized on disk as a sibling of your memory directory:

```bash
ls "$MEMORY_DIR/../"           # attached repositories appear here by name
cat "$MEMORY_DIR/../<repo-name>/<path>"
```

If you don't see an expected repository on disk, fall back to the API (below) — it always works regardless of environment.

## API Operations

All operations go through the Letta API using `$LETTA_API_KEY` via the Bash tool. Use `https://api.letta.com` (or `$LETTA_BASE_URL` if set — e.g. when running under Letta Desktop, which proxies auth). Responses are JSON.

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

### Attaching Repositories to Agents

Attaching makes the repository's contents available to the agent in its environments.

```bash
# List repositories attached to an agent
curl -sS "$BASE/v1/agents/{agent_id}/repositories" -H "$AUTH"

# Attach
curl -sS -X POST "$BASE/v1/agents/{agent_id}/repositories" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"repository_id": "repo-..."}'

# Detach
curl -sS -X DELETE "$BASE/v1/agents/{agent_id}/repositories/{repository_id}" -H "$AUTH"
```

Attaching is asynchronous — after a POST, poll the list endpoint until the repository appears before relying on it. You can attach a repository to yourself (`$AGENT_ID`) or to another agent to share context with it.

## Notes and Limits

- Repository files are **text** content; binary files are not supported via the files API.
- Use the `content_sha256` precondition on updates when multiple agents may write the same file — on failure, re-read and retry.
- SDK equivalent: `@letta-ai/letta-agent-sdk` exposes these operations as `client.repositories` (with `files` and `versions` helpers) and supports attaching repos for a session's lifetime via `resources: [{ type: "repository", repositoryId }]` on cloud sessions.
