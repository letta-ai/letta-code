Multiple reflection agents have each processed a time-ordered batch of recorded sessions and produced independent memory filesystems. Your job is to merge them into the primary agent's memory filesystem.

The reflection directories are the {{count}} numbered subdirectories of:
{{batchesDir}}

Subdirectory numbers are in time order — higher numbers reflect more recent sessions and are more recent evidence. A batch whose `output/` has no commits beyond the seed files produced no learnings; skip it.

Merge into the memory filesystem at `$MEMORY_DIR` — the primary agent's REAL memory (a git repo), including everything learned in past sessions. Inspect it first (`find`, `cat` the `system/` files, `git log` for past reflection history) and reconcile new learnings with what is already stored: update existing files at the source, never concatenate competing versions. The reflection directories are read-only inputs; all writes stay under `$MEMORY_DIR`. Use Edit for existing files and Bash heredocs for new ones.

## Commit

When the merge is complete, from `$MEMORY_DIR`:

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
