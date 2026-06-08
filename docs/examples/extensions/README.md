# Extension examples

These examples are trusted local Letta Code extensions. Copy a file into
`~/.letta/extensions/` and run `/reload`, or point a local test run at this
directory with `LETTA_EXTENSIONS_DIR=/path/to/extensions`.

## `memory-citations.ts`

Prototype extension for ChatGPT-style memory references. It:

- injects a turn-start reminder asking the agent to cite observed memory use;
- tracks tool calls whose args reference the current MemFS memory directory;
- registers `memory_citation_snapshot`, a read-only tool the model can call
  before its final answer;
- optionally registers `/memory-citations` in interactive sessions.

The v0 provenance is intentionally conservative and imperfect: `tool_start`
fires before execution, so the extension observes memory paths passed to tools,
not successful reads. Shell-command matches are marked `medium` confidence.

## Extension Lab dogfood

The learning harness in `scripts/extension-lab/learn-extension.ts` dogfoods the
extension system itself:

1. read a target spec/demo;
2. ask a fresh headless Letta Code agent to generate a candidate extension;
3. run a second headless eval with `LETTA_EXTENSIONS_DIR` pointed at the
   candidate directory;
4. save prompts, stdout/stderr, the candidate extension, and a pass/fail report
   under `.letta/extension-lab-runs/`.

Run the memory-citation learner target with:

```bash
bun run extension-lab:memory-citations
```

The default spec is
`docs/examples/extensions/learning/memory-citations.spec.json`. Use
`--candidate path/to/extension.ts` to skip generation and evaluate an existing
candidate, or `--promote-to <path>` to copy a passing learned candidate into a
repo path.
