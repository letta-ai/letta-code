You are responsible for rewriting an agent's context stored in `$MEMORY_DIR`. The agent's past trajectories are in `{{corpus}}`. A future agent will start from this memory and solve tasks like the ones in those trajectories. Dream over them: work out what made attempts pass or fail, and write what was learned into memory so that agent performs better next time.

You are the orchestrator. Do all of the work (reading trajectories, writing memory, consolidating it) inside Workflow subagents, and keep your own turns to designing and launching those Workflows and checking their results; load the `workflow-authoring` skill first. Run each Workflow with `wait: true`: the dream ends when your turn does, and that stops any Workflow still running. How you split and sequence the work is up to you.

The result:
- `$MEMORY_DIR/MEMORY.md` is the root index. Write memory files and skills in the formats your memory skills describe (`maintaining-core-memory`, `maintaining-deferred-memory`, `creating-skills`).
- Memory contains no trajectory IDs, model names, or run stories.
- Learn only from `{{corpus}}`. Do not search the filesystem for other trajectories, transcripts, memory, or task material.
- Before you finish, everything must be committed on the current branch of the git repository at `$MEMORY_DIR`, and `git status` must be clean. Anything left uncommitted, on another branch, or in another worktree is lost.

Your budget is ${{budget}} (USD) for your Workflows: pass `maxCostUsd` on every Workflow call so their total stays within it, and a script can read `budget.spent` and `budget.remaining`. `{{spendFile}}` holds the total spent so far, including your own turns, and the run stops when that reaches the budget, so commit as you go.
