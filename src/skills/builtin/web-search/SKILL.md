---
name: web-search
description: Search the web through the You.com MCP server. Load when the user asks about anything current — news, prices, releases, docs, or facts that may have changed since training — or wants sources and citations, and this agent has no web-search tool connected yet. Do not load for browser automation (use browser-use) or for questions answerable from local files and memory.
---

# Web Search (You.com)

Local Letta Code agents have no built-in web search: `web_search` and
`fetch_webpage` are Letta Cloud server-side tools. This skill connects the
You.com MCP server (`api.you.com`) so the agent can search the live web.
The free endpoint needs no account or credentials.

## Before adding a server

Check what is already connected:

```bash
letta mcp list && letta mcp tools
```

If a search-capable tool is already available (`web_search`, or another
search MCP server), use it — do not add a second one. Add You.com only when
the agent cannot search the web yet or the user asks for it.

`/mcp add` persists a settings change for this agent. The keyless endpoint is
safe to add when web search is needed; confirm with the user before wiring an
API key.

## Connect

```bash
# keyless — you-search and you-discover, 100 queries/day, no signup
/mcp add --transport http youcom https://api.you.com/mcp?profile=free

# with an API key (you.com/platform) — higher limits, plus you-contents,
# you-research, you-answer, and you-finance
/mcp add --transport http youcom https://api.you.com/mcp --auth-env YOU_API_KEY
```

After connecting, the tools are directly callable as `mcp__youcom__you-search`
and friends, or through the CLI — list `letta mcp tools` to see the exact
names, then `letta mcp call <tool-name> --args '{"query":"..."}'` (see the
using-mcp-tools skill).

## Tools

| Tool | Tier | Use |
|---|---|---|
| `you-search` | free | Ranked web results with URLs, snippets, and query-relevant passages |
| `you-discover` | free | Find AI agents, MCP servers, A2A agents, and skills (search only) |
| `you-contents` | key | Full page content as markdown or HTML |
| `you-research` | key | Multi-step research: searches, reads, synthesizes a cited answer |
| `you-answer` | key | Direct answer grounded in search results |
| `you-finance` | key | Financial data and market queries |

`you-search` accepts `query` (required), `count` (1–100, default 30),
`freshness` (`day`/`week`/`month`/`year` or `YYYY-MM-DDtoYYYY-MM-DD` — use
when recency matters, omit for evergreen facts), and `extraction`
(`highlights` default; `none` for plain snippets; `full_page` to crawl each
result).

## Query discipline

- One intent per search, phrased naturally: `tariff exemptions for
  semiconductor imports 2026` — not a question, not a pile of synonyms.
- Inline filters are mapped automatically: `site:cdc.gov`, `lang:fr`,
  `loc:DE`.
- On zero results, do not repeat the query: widen it, drop filters, or read
  the best prior result.
- Snippets and highlights are not page content. Before citing specifics,
  read the page — with `you-contents` (key tier) or `curl` via Bash — instead
  of trusting the snippet.
- The keyless tier is capped at 100 queries/day; prefer fewer, well-formed
  searches, and fall back to `curl` for pages already found.

Pages that need a real browser (JavaScript rendering, login, bot protection)
belong to the browser-use skill, not this one.
