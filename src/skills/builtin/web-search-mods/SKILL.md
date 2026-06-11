---
name: web-search-mods
description: Create trusted local Letta Code mods that add model-callable web search tools for local agents using Perplexity, Exa, or Parallel APIs.
when_to_use: Use when a local Letta Code agent needs web search, or when asked to add Perplexity, Exa, Parallel, live web, search, or research capability through a mod or extension.
category: integrations
tags: web search mods local-agent perplexity exa parallel
---

# Web search mods for local agents

Use this skill when a local agent needs web search. The implementation path is a trusted local mod that registers a model-callable search tool.

## Rules

- Current naming is **mod**, not extension. Prefer `~/.letta/mods/`. Legacy `~/.letta/extensions/` is only for backwards compatibility.
- Do not add provider SDK dependencies. Use `fetch` and standard runtime APIs so the mod works in a stock Letta Code install.
- Do not hard-code API keys. Read from environment variables:
  - `PERPLEXITY_API_KEY`
  - `EXA_API_KEY`
  - `PARALLEL_API_KEY`
- Web search sends query text to a third-party provider. Tell the user which provider/env var the mod uses.
- A search tool is read-only and may be marked `parallelSafe: true`. If the user wants approval before network calls, set `requiresApproval: true`; otherwise use `false` for normal web-search behavior.
- After writing or editing a mod, tell the user to run `/reload` or restart Letta Code.
- If a mod breaks startup, recover with `letta --no-mods` or `LETTA_DISABLE_MODS=1 letta`.

## Workflow

1. Ask which provider to use if the user did not specify one.
2. Create `~/.letta/mods/` if needed.
3. Write one focused mod file, for example:
   - `~/.letta/mods/perplexity-search.ts`
   - `~/.letta/mods/exa-search.ts`
   - `~/.letta/mods/parallel-search.ts`
4. Use the matching reference file below.
5. Confirm the required environment variable and reload step.

## Provider examples

Load only the reference you need:

| Provider | Tool name | Required env var | Reference |
| --- | --- | --- | --- |
| Perplexity | `perplexity_search` | `PERPLEXITY_API_KEY` | `references/perplexity.md` |
| Exa | `exa_search` | `EXA_API_KEY` | `references/exa.md` |
| Parallel | `parallel_search` | `PARALLEL_API_KEY` | `references/parallel.md` |

If the user asks for all three, install all three files. The tool names are provider-scoped so they can coexist.
