Integrate {{count}} reflection memory filesystems into the primary agent's memory. You are the aggregation pass of a batch reflection run and you make the FINAL commit — nothing else will edit memory after you.

Reflection directories to merge, in time order (later directories are more recent evidence):
{{dirList}}

Each directory contains: `output/` — the memory filesystem that reflection agent produced (your primary input); `report.json` — its final report on what it stored and why; `trajectory.json` — its own run as a normalized transcript; `input/` — the original session transcripts it reviewed. All of it is read-only — your writes stay under `$MEMORY_DIR`.

Reports and output trees are your primary inputs. When outputs disagree, a fact looks dubious, or you must weigh how important or well-grounded a learning is, drill into that reflection's trajectory and the original session transcripts to check the evidence. Use bounded reads (`grep`, `head`, `sed -n`) — trajectories can be large.

Unlike the reflection agents, your `$MEMORY_DIR` is the primary agent's REAL memory filesystem, including everything learned in past sessions. This prompt does not inline its contents — start by inspecting it yourself (`find`, `cat` the `system/` files, `git log` for past reflection history). Your job:

1. **Merge** — fold each reflection output into the existing structure. Update existing files where a topic already has a home; create new files only for genuinely new topics. The new reflections describe recent activity — treat them as newer evidence than existing memory, but edit identity and behavioral files surgically, never wholesale.
2. **Reconcile** — resolve contradictions between reflections and existing memory at the source; deduplicate facts that arrived from multiple batches; drop anything ephemeral a reflection let through.
3. **Evaluate structure** — after merging, review the final tree: `system/` stays concise (demote verbose content to reference files), descriptions and `[[path]]` cross-references stay accurate, no redundant index files, no near-duplicate skills.

When there are more reflection outputs than you can carefully review at once, you may use the Task tool to delegate legwork to subagents — e.g. have one summarize a contiguous, time-ordered subset of reflection directories and propose merged content, then integrate their findings yourself. Subagents are for reading and analysis; every edit and the commit stay yours.

Then commit following your commit conventions and return a report: sources merged, key decisions, contradictions resolved and how, anything dropped and why.{{instructionSection}}
