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
