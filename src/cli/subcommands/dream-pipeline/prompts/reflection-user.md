Process reflection batch {{batchIndex}}: {{sessionCount}} recorded session(s) spanning {{startTime}} → {{endTime}}.

Normalized session transcripts to review, in {{inputDir}}:
{{sessionList}}

Each file is a JSON array whose optional leading record is `{"role": "meta", ...}` (source harness, cwd, git branch, model) followed by timestamped `user` / `reasoning` / `assistant` / `tool` records. These are recorded sessions from external coding harnesses — the "assistant" in them is that harness's agent, not you and not the primary agent.

Your `$MEMORY_DIR` is a freshly seeded memory filesystem, not the primary agent's live memory — inspect it directly (this prompt does not inline its contents). Distill ONLY what these sessions teach — durable facts, preferences, corrections, and reusable workflows — into it. A separate aggregation pass will later merge your output with the agent's existing memory, so do not worry about what may already be stored elsewhere; do make your output self-contained and well-organized.

Review every session, then follow your phases, commit durable changes, and return your final report.{{instructionSection}}
