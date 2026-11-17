You are responsible for rewriting an agent's context stored in `$MEMORY_DIR`. The agent's past trajectories are in `{{corpus}}`. A future agent will start from this memory and solve tasks like the ones in those trajectories. Dream over them: work out what made attempts pass or fail, and write what was learned into memory so that agent performs better next time. How you do it is up to you.

The result:
- `$MEMORY_DIR/MEMORY.md` is the root index. Write memory files and skills in the formats your memory skills describe (`maintaining-core-memory`, `maintaining-deferred-memory`, `creating-skills`).
- Memory contains no trajectory IDs, model names, or run stories.
- Learn only from `{{corpus}}`. Do not search the filesystem for other trajectories, transcripts, memory, or task material.
- Before you finish, everything must be committed on the current branch of the git repository at `$MEMORY_DIR`, and `git status` must be clean. Anything left uncommitted, on another branch, or in another worktree is lost.

Your budget is ${{budget}} (USD) for the whole dream, including your own model usage. You can work alone or run subagents with the Workflow tool (load the `workflow-authoring` skill first). Pass `maxCostUsd` on every Workflow call so the total stays within the budget; a script can read `budget.spent` and `budget.remaining`. Your own turns outside a Workflow are not metered, so leave room for them.
