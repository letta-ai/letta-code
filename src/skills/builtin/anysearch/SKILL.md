---
name: anysearch
description: Search the web, discover sub-domains, run batch searches, or extract page content through the built-in AnySearch MCP preset. Load when the user asks about anything current — news, prices, releases, docs, or facts that may have changed since training — wants sources/citations, needs several independent searches at once, or wants a site's sub-domains enumerated, and this agent has no search tool connected yet. Do not load for browser automation (use browser-use) or for questions answerable from local files and memory.
---

# AnySearch (built-in preset)

`web_search` and `fetch_webpage` are Letta Cloud server-side tools —
bootstrapped by a Letta core server, not executed by this client. An agent
running purely on a local backend with no such server behind it has no
equivalent tool until one is connected. AnySearch is a built-in MCP
preset bundled with Letta Code (`src/mcp-presets.ts`) that connects
`https://api.anysearch.com/mcp` through the existing `/mcp add` mechanism —
no manual URL, transport, or header configuration required. It works
anonymously (no account) or with an `ANYSEARCH_API_KEY` (see "Configuring
`ANYSEARCH_API_KEY`" below); check AnySearch's own current documentation for
whether authentication changes rate limits or tool availability — this
skill does not assume a specific tier structure beyond what's documented in
the tool table below.

## Before adding a server

Check what is already connected:

```bash
letta mcp list && letta mcp tools
```

If a search-capable tool is already connected, use it — do not add a second
one. Add AnySearch only when the agent cannot search the web yet or the user
specifically asks for AnySearch, sub-domain discovery, batch search, or page
extraction.

## Connect

```
/mcp add anysearch
```

That single bare word is the only form recognized as the AnySearch preset.
Anything else — extra flags or arguments, or any `--transport ...`
invocation — is parsed as an ordinary manual `/mcp add`, exactly as before
this preset existed; use manual `/mcp add --transport http <name> <url>`
syntax if you need something the preset doesn't cover.

Whether the connection is anonymous or authenticated is decided from
whether `ANYSEARCH_API_KEY` is present in **the Letta Code process's own
environment** at the moment `/mcp add anysearch` runs — see "Configuring
`ANYSEARCH_API_KEY`" immediately below before assuming a key is picked up.
Anonymous mode needs no key at all: the preset never sends an empty or
placeholder-only `Authorization` header when no key is configured — it
simply omits the header.

### Configuring `ANYSEARCH_API_KEY`

`ANYSEARCH_API_KEY` must already be in the environment **of the running
Letta Code process itself** — not merely available somewhere on the
machine — when `/mcp add anysearch` runs. Concretely:

- Set it in the shell **before starting (or restarting) Letta Code**, e.g.
  `export ANYSEARCH_API_KEY=... ` in your shell profile or immediately
  before launching `letta`, or `ANYSEARCH_API_KEY=... letta`.
- **Do not** expect `export ANYSEARCH_API_KEY=...` run through this agent's
  own Bash tool, from inside an already-running Letta Code session, to
  work — a child process's environment variable does not propagate back to
  the parent Letta Code process. If the key isn't already in Letta Code's
  environment when it started, a Bash `export` from within the session
  cannot fix that for the current process; restart Letta Code with the key
  set first.
- **Never** paste the plaintext key value into chat, into a `/mcp add`
  command, into any committed config file, or into documentation. It is
  never persisted as plaintext by this preset either way — see "Key
  lifecycle" below — but the guidance above is about not exposing it
  through channels this integration doesn't control (chat history, shell
  history, etc.).
- Anonymous mode requires no key at all — skip this section entirely if
  you don't need authenticated access.

### Key lifecycle

- **Added anonymously** (no key present at add-time): no `Authorization`
  placeholder is persisted. Setting the environment variable afterward does
  **not** retroactively add it — remove and re-add the server (with the key
  already in Letta Code's environment) to switch to authenticated mode.
- **Added authenticated** (key present at add-time): the persisted config
  stores only the literal `${ANYSEARCH_API_KEY}` placeholder, never the
  real value. The actual value is resolved from the environment fresh at
  each connection — so rotating the key's value doesn't require rebuilding
  the config, as long as Letta Code has the new value in its own
  environment before the next reconnect (typically: restart Letta Code with
  the updated value set). If the variable is missing or blank
  (empty/whitespace-only) when a connection is attempted, the connection
  fails with a clear error rather than silently sending an empty or
  whitespace-only `Authorization` value.
- **Returning to anonymous**: remove and re-add the server with the key
  genuinely absent from Letta Code's environment at add-time.

After connecting, list the actual callable tool names with
`letta mcp tools anysearch` (or `letta mcp tools --full`) before calling
one — `mcp__anysearch__search` is the typical name when there's no server
or tool-name collision, but Letta's alias system can suffix it
(`mcp__anysearch_2__search`, etc.) if another connected server collides, so
it is not a guaranteed invariant. Then call with
`letta mcp call <tool-name> --args '{"query":"..."}'` (see the
using-mcp-tools skill), or the tool is directly available to the model
under whatever name `letta mcp tools` reports.

## Tools

Primary-source-verified against AnySearch's own MCP server README
(`anysearch-ai/anysearch-mcp-server`, commit `e3f2701a21e61419ebd140358f0b1abb1f5ded04`,
fetched directly — not inferred). Still confirm against the live `tools/list`
before relying on this if it's ever out of date relative to what you're
connected to.

| Tool | Parameters | Use |
|---|---|---|
| `search` | `query` (required, natural language, one intent per call); `domain`, `sub_domain`, `sub_domain_params` (optional, vertical — see below); `max_results` (optional, 1–10, default 10) | General or vertical web search |
| `get_sub_domains` | `domain` (single) or `domains` (array, batch up to 5 — preferred, covers more ground); one of the two is required | Query the vertical-domain directory; **required before any `search` call that uses `domain`** — returns a Markdown table of valid sub-domains and their parameter schemas |
| `batch_search` | `queries` (required, 1–5 objects, each with the same fields as `search`) | Run several independent searches in one call; a single failed query does not block the others |
| `extract` | `url` (required, `http://` or `https://`) | Fetch an HTML page and return its content as Markdown (truncated at 50,000 characters), rather than trusting a search snippet |

**Do not guess field names, and never invent `sub_domain`/`sub_domain_params`
values.** Before calling `get_sub_domains` or any vertical/parameterized
search, run `letta mcp tools` (or the equivalent tools/list output) to
confirm the exact current schema — the parameter names above are what the
verified source states as of the commit cited, not a guarantee for whatever
version you're actually connected to. The MCP surface uses `domain`,
`sub_domain`, and `sub_domain_params` — this is **not** the same shape as
AnySearch's REST API, which uses `tag`/`params`. Do not port REST field
names into an MCP call; if the live schema differs from this table, trust
the live schema.

Anonymous access works for every tool above, at lower rate limits than an
authenticated key — this is not a feature-gated tier, just a rate-limit
difference, per the verified source.

Out of scope for this integration: AnySearch's own README also documents a
self-service API-key registration flow (a REST call to
`https://api.anysearch.com/v1/auth/email/register` that creates an account
and returns a one-time plaintext key). This preset does **not** implement
or wire up that flow — it only consumes an already-obtained
`ANYSEARCH_API_KEY`. Do not attempt to register an account or key on the
user's behalf through this skill; if a user needs a key, point them at
`https://anysearch.com/console/api-keys` (the manual signup path the same
README also documents) rather than automating registration.

## Batch search discipline

`batch_search` accepts 1–5 independent queries per call (`queries`, each
with the same fields as `search`). A failed query inside a batch does not
block or erase the other, successful results — check each sub-result
independently rather than treating the whole call as pass/fail. Use it to
parallelize genuinely independent questions (e.g. three unrelated lookups),
not as a substitute for a single well-formed `search` query.

## Extraction limits

`extract` takes an HTML page as input (`url`, `http://` or `https://`) and
returns its content as **Markdown** (not raw HTML). The returned Markdown is
**truncated at 50,000 characters**; for a longer page, treat the result as
partial rather than assuming the whole page was captured. Do not claim
support for PDF, DOCX, or other input formats unless a live
`tools/list`/schema response says otherwise for the version you're
connected to.

## Query discipline

- One clear intent per search — don't stuff unrelated intents into one
  query.
- Natural-language phrasing or concise keywords are both fine; AnySearch's
  own docs describe the `query` field simply as "natural language search
  query," not as prose-only or keyword-only. A question is a perfectly
  valid query.
- Include exact names, IDs, dates, versions, etc. when they're relevant —
  specificity helps more than genericity.
- On zero results, do not repeat the query verbatim: widen it, drop filters,
  or read the best prior result.
- Snippets are not page content. Before citing specifics, use `extract`
  instead of trusting a search snippet.

## Troubleshooting

If `/mcp add anysearch` reports a failure, the connection did not succeed —
a saved config is never treated as a working integration. Common causes:

- **"MCP server anysearch already exists"** — a prior add (successful or
  failed) already saved this name. This is not itself an error to retry
  around: open the `/mcp` manager and use its `R` reconnect action for a
  transient network retry against the same saved config; only remove and
  re-add when the saved config itself must change (e.g. switching
  anonymous ↔ authenticated — see "Key lifecycle" above).
- **Connection failure** (network/DNS/TLS) — the error names the failure;
  use the `/mcp` manager's reconnect action once, then report it rather
  than assuming the tool is available.
- **Auth failure** — usually an invalid/expired key, or the key genuinely
  wasn't in Letta Code's environment when `/mcp add anysearch` ran (see
  "Configuring `ANYSEARCH_API_KEY`" above); remove the server (`/mcp`
  manager) and re-add after fixing the key.
- **Rate limit / quota** — surfaces as a tool result or JSON-RPC error from
  AnySearch, not a Letta Code error; back off and retry later rather than
  looping.
- **Malformed invocation** — check the live tool schema (`letta mcp tools`)
  before assuming a parameter name; do not invent `sub_domain_params` shapes
  without confirming them first.

Pages that need a real browser (JavaScript rendering, login, bot protection)
belong to the browser-use skill, not this one.
