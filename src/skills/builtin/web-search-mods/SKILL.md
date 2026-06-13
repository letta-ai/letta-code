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
- Current mod APIs do not expose `letta.runtime.backend`, `ctx.runtime`, `ctx.cloud`, `ctx.secrets`, or `requiresSecrets`. Do not invent those fields in examples.
- Do not hard-code API keys. Until mod-owned or local-agent `/secret` support exists, read provider keys from environment variables available to the Letta Code process:
  - `PERPLEXITY_API_KEY`
  - `EXA_API_KEY`
  - `PARALLEL_API_KEY`
- If the user changes an environment variable, they must restart Letta Code with the variable set. `/reload` reloads mod files, not the parent process environment.
- Web search sends query text to a third-party provider. Tell the user which provider/env var the mod uses.
- Use provider-scoped tool names such as `perplexity_search`, `exa_search`, and `parallel_search`. Do not register a generic `web_search` mod until the mod runtime has a supported cloud/local routing and secret API.
- A search tool is read-only and may be marked `parallelSafe: true`. If the user wants approval before network calls, set `requiresApproval: true`; otherwise use `false` for normal web-search behavior.
- After writing or editing a mod file, tell the user to run `/reload` or restart Letta Code.
- If a mod breaks startup, recover with `letta --no-mods` or `LETTA_DISABLE_MODS=1 letta`.

## Workflow

1. Ask which provider to use if the user did not specify one.
2. Create `~/.letta/mods/` if needed.
3. Write one focused mod file, for example:
   - `~/.letta/mods/perplexity-search.ts`
   - `~/.letta/mods/exa-search.ts`
   - `~/.letta/mods/parallel-search.ts`
4. Use the matching reference file below.
5. Confirm the required environment variable. If the variable was not set before Letta Code started, tell the user to restart Letta Code with it set.

## Provider examples

Load only the reference you need:

| Provider | Tool name | Required env var | Reference |
| --- | --- | --- | --- |
| Perplexity | `perplexity_search` | `PERPLEXITY_API_KEY` | `references/perplexity.md` |
| Exa | `exa_search` | `EXA_API_KEY` | `references/exa.md` |
| Parallel | `parallel_search` | `PARALLEL_API_KEY` | `references/parallel.md` |

If the user asks for all three, install all three files. The tool names are provider-scoped so they can coexist.
