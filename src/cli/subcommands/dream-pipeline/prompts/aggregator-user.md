Multiple reflection agents have each processed a time-ordered batch of recorded sessions, each editing its own isolated copy of the primary agent's memory filesystem (all taken at the same base revision). Your job is to synthesize their changes into the primary agent's memory.

The reflection directories are the {{count}} numbered subdirectories of:
{{batchesDir}}

Each contains `diff.patch` — that batch's changes relative to the shared base, your PRIMARY input — plus `output/` (the full edited copy), `report.json` (the agent's final report), `trajectory.json` (its run as a normalized transcript), and `input/` (the original session transcripts). Subdirectory numbers are in time order — higher numbers reflect more recent sessions and are more recent evidence. An empty diff means the batch found nothing durable; skip it.

`$MEMORY_DIR` is the primary agent's REAL memory filesystem at the same base revision the diffs apply to. All the reflection directories are read-only; your writes stay under `$MEMORY_DIR`. Use Edit for existing files and Bash heredocs for new ones.

## Workflow

1. **Survey the diffs.** Start with `diffstat`-level views (`grep '^diff --git' */diff.patch`, per-file summaries) to map which files were modified and which were created across all batches.
2. **Decide the cohesive structure.** From that file-change map, determine any structural changes the merged result needs — reorganizing, combining, renaming, adding, or deleting files — before editing content.
3. **Synthesize, don't merge.** Where several diffs touch the same file, do NOT attempt a git merge: make ONE edit that reflects all the information represented across those diffs (latest evidence wins on contradictions, duplicates collapse to one entry).
4. **Dispatch subagents for focused aspects.** Use the Task tool to delegate aggregation of a specific aspect of memory — e.g. one subagent to reconcile all the changes to `system/human.md` across batches, another for skills. Subagents read and propose; every edit and the commit stay yours.

## Commit

When the synthesis is complete, from `$MEMORY_DIR`:

```bash
git add -A
git commit -m "feat(aggregation): merge <N> reflection outputs 🔮

Sources:
- <batch directories merged>

Notes:
- <key merge decisions, contradictions resolved>"
```

## Report

Return a final report: sources merged, key decisions, contradictions resolved and how, anything dropped and why, and the commit subject.{{instructionSection}}
