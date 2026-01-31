---
name: syncing-memory-filesystem
description: Manage memory filesystem sync conflicts with git-like commands. Load this skill when you receive a memFS conflict notification, need to check sync status, review diffs, or resolve conflicts between memory blocks and their filesystem counterparts.
---

# Memory Filesystem Sync

When memFS is enabled, your memory blocks are mirrored as `.md` files on disk at `~/.letta/agents/<agent-id>/memory/`. Changes to blocks or files are detected via content hashing and synced at startup and on manual `/memfs sync`.

**Conflicts** occur when both the file and the block are modified since the last sync (e.g., user edits a file in their editor while the block is also updated manually by the user via the API). Non-conflicting changes (only one side changed) are resolved automatically during the next sync.

## CLI Commands

Use the built-in CLI subcommands. They use the same auth flow as the CLI
(OAuth/keychain + refresh), and default to `LETTA_AGENT_ID` when available.

```bash
letta memfs status --agent <agent-id>
letta memfs diff --agent <agent-id>
letta memfs resolve --agent <agent-id> --resolutions '<JSON>'
```

Auth overrides (optional):
```bash
LETTA_API_KEY=... letta memfs status --agent <agent-id>
LETTA_BASE_URL=http://localhost:8283 LETTA_API_KEY=... letta memfs status --agent <agent-id>
```

**Output**: JSON only.

**Status output fields**:
- `conflicts` — blocks where both file and block changed
- `pendingFromFile` — file changed, block didn’t (auto-resolved on sync)
- `pendingFromBlock` — block changed, file didn’t (auto-resolved on sync)
- `newFiles` — files without corresponding blocks
- `newBlocks` — blocks without corresponding files
- `locationMismatches` — file location doesn’t match attachment state
- `isClean` — true if everything is in sync
- `lastSync` — timestamp of last sync

**Diff output**:
- Writes a markdown diff file and returns `{ diffPath, conflicts, metadataOnly }`

**Resolve output**:
- Returns the sync result from `syncMemoryFilesystem` (created/updated/deleted blocks/files, conflicts).

## Typical Workflow

1. You receive a system reminder about memFS conflicts
2. Run `letta memfs diff` to see the full content of both sides
3. Read the diff file to understand the changes
4. Decide for each conflict: keep the file version or the block version
5. Run `letta memfs resolve` with all resolutions at once

## Example

```bash
# Step 1: Check status (optional — the system reminder already tells you about conflicts)
letta memfs status --agent $LETTA_AGENT_ID

# Step 2: View the diffs
letta memfs diff --agent $LETTA_AGENT_ID
# Output: "Diff (2 conflicts) written to: /path/to/diff.md"

# Step 3: Read the diff file (use Read tool on the path from step 2)

# Step 4: Resolve all conflicts
letta memfs resolve --agent $LETTA_AGENT_ID --resolutions '[{"label":"persona/soul","resolution":"block"},{"label":"human/prefs","resolution":"file"}]'
```

## How Conflicts Arise

- **User edits a `.md` file** in their editor or IDE while the corresponding block is also modified manually by the user via the API
- **Both sides diverge** from the last-synced state — neither can be resolved automatically without potentially losing changes
- The system detects this after each turn and notifies you via a system reminder

## Notes

- Non-conflicting changes (only one side modified) are resolved automatically during the next sync — you only need to intervene for true conflicts
- The `/memfs sync` command is still available for users to manually trigger sync and resolve conflicts via the CLI overlay
- After resolving, the sync state is updated so the same conflicts won't reappear
