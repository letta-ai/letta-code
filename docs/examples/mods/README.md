# Mod examples

These examples are trusted local Letta Code mods. Copy a file into
`~/.letta/mods/` and run `/reload`, or point a local test run at this
directory with `LETTA_MODS_DIR=/path/to/mods` (or legacy
`LETTA_EXTENSIONS_DIR` on pre-rename branches).

## `memory-citations.ts`

Prototype mod for ChatGPT-style memory references. It:

- injects a turn-start reminder asking the agent to cite observed memory use;
- tracks tool calls whose args reference the current MemFS memory directory;
- registers `memory_citation_snapshot`, a read-only tool the model can call
  before its final answer;
- optionally registers `/memory-citations` in interactive sessions.

The v0 provenance is intentionally conservative and imperfect: `tool_start`
fires before execution, so the mod observes memory paths passed to tools,
not successful reads. Shell-command matches are marked `medium` confidence.

## Mod learning dogfood

The learning harness in `scripts/mod-learning/learn-mod.ts` dogfoods the
mod system itself:

1. read a target env/demo;
2. ask a fresh headless Letta Code agent to generate a candidate mod;
3. run a second headless eval with `LETTA_MODS_DIR` pointed at the
   candidate directory;
4. save prompts, stdout/stderr, the candidate mod, and a pass/fail report
   under `.letta/mod-learning-runs/`.

Run the memory-citation learner target with:

```bash
bun run mod-learning:memory-citations
```

From inside the Letta Code TUI, run the same built-in target with:

```text
/mods learn memory-citations
```

The TUI command streams progress into the transcript and writes the same
candidate/report artifacts under `.letta/mod-learning-runs/`. It never installs
or promotes the learned mod automatically; review the generated candidate
before copying it into your local mod directory and running `/reload`.

Shell/script usage also runs detached by default and writes `background.stdout`,
`background.stderr`, and `background.json` into the run directory while the main
process returns immediately. Pass `--foreground` when you need the script to
block and return a pass/fail exit code, for example in CI.

The default env is
`docs/examples/mods/learning/memory-citations.env.json`. Use
`--candidate path/to/mod.ts` to skip generation and evaluate an existing
candidate, or `--promote-to <path>` to copy a passing learned candidate into a
repo path.
