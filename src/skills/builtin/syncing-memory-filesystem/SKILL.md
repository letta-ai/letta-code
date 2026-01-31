---
name: syncing-memory-filesystem
description: Manage memory filesystem sync conflicts with git-like commands. Load this skill when you receive a memFS conflict notification, need to check sync status, review diffs, or resolve conflicts between memory blocks and their filesystem counterparts.
---

# Memory Filesystem Sync

When memFS is enabled, your memory blocks are mirrored as `.md` files on disk at `~/.letta/agents/<agent-id>/memory/`. Changes to blocks or files are detected via content hashing and synced at startup and on manual `/memfs sync`.

**Conflicts** occur when both the file and the block are modified since the last sync (e.g., user edits a file in their editor while the block is also updated manually by the user via the API). Non-conflicting changes (only one side changed) are resolved automatically during the next sync.

## Scripts

Three scripts provide a git-like interface for managing sync status:

### 1. `memfs-status.ts` — Check sync status (like `git status`)

```bash
npx tsx <SKILL_DIR>/scripts/memfs-status.ts $LETTA_AGENT_ID
```

**Output**: JSON object with:
- `conflicts` — blocks where both file and block changed (need manual resolution)
- `pendingFromFile` — file changed, block didn't (resolved on next sync)
- `pendingFromBlock` — block changed, file didn't (resolved on next sync)
- `newFiles` — files without corresponding blocks
- `newBlocks` — blocks without corresponding files
- `isClean` — true if everything is in sync
- `lastSync` — timestamp of last sync

Read-only, safe to run anytime.

### 2. `memfs-diff.ts` — View conflict details (like `git diff`)

```bash
npx tsx <SKILL_DIR>/scripts/memfs-diff.ts $LETTA_AGENT_ID
```

**Output**: Writes a formatted markdown diff file showing both the file version and block version of each conflicting label. The path to the diff file is printed to stdout.

Use the `Read` tool to review the diff file content.

### 3. `memfs-resolve.ts` — Resolve conflicts (like `git merge`)

```bash
npx tsx <SKILL_DIR>/scripts/memfs-resolve.ts $LETTA_AGENT_ID --resolutions '<JSON>'
```

**Arguments**:
- `--resolutions` — JSON array of resolution objects

**Resolution format**:
```json
[
  {"label": "persona/soul", "resolution": "block"},
  {"label": "human/prefs", "resolution": "file"}
]
```

**Resolution options**:
- `"file"` — Overwrite the memory block with the file contents
- `"block"` — Overwrite the file with the memory block contents

All resolutions must be provided in a single call (stateless).

## Typical Workflow

1. You receive a system reminder about memFS conflicts
2. Run `memfs-diff.ts` to see the full content of both sides
3. Read the diff file to understand the changes
4. Decide for each conflict: keep the file version or the block version
5. Run `memfs-resolve.ts` with all resolutions at once

## Example

```bash
# Step 1: Check status (optional — the system reminder already tells you about conflicts)
npx tsx <SKILL_DIR>/scripts/memfs-status.ts $LETTA_AGENT_ID

# Step 2: View the diffs
npx tsx <SKILL_DIR>/scripts/memfs-diff.ts $LETTA_AGENT_ID
# Output: "Diff (2 conflicts) written to: /path/to/diff.md"

# Step 3: Read the diff file (use Read tool on the path from step 2)

# Step 4: Resolve all conflicts
npx tsx <SKILL_DIR>/scripts/memfs-resolve.ts $LETTA_AGENT_ID --resolutions '[{"label":"persona/soul","resolution":"block"},{"label":"human/prefs","resolution":"file"}]'
```

## How Conflicts Arise

- **User edits a `.md` file** in their editor or IDE while the corresponding block is also modified manually by the user via the API
- **Both sides diverge** from the last-synced state — neither can be resolved automatically without potentially losing changes
- The system detects this after each turn and notifies you via a system reminder

## Notes

- Non-conflicting changes (only one side modified) are resolved automatically during the next sync — you only need to intervene for true conflicts
- The `/memfs sync` command is still available for users to manually trigger sync and resolve conflicts via the CLI overlay
- After resolving, the sync state is updated so the same conflicts won't reappear
