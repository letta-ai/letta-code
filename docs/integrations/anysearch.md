# AnySearch built-in MCP preset — maintainer notes

This document is maintenance-facing: how the AnySearch integration is wired,
what it depends on, and how to change or re-verify it. User-facing usage
lives in the bundled skill. No single path resolves it in both the source
repository and the published npm package (the published package ships only
the built `skills/` directory, not `src/`), so it's given as two plain
paths rather than a hyperlink that would 404 in one context or the other:

- Source: `src/skills/builtin/anysearch/SKILL.md`
- Published artifact (after `bun run build`): `skills/anysearch/SKILL.md`

## Architecture

AnySearch is **not** a native tool and does not execute any code locally
beyond the existing generic MCP client. It is an entry in the built-in MCP
preset registry (`src/mcp-presets.ts`) added by this contribution, resolved and wired
through infrastructure that already exists. The integration reuses the
existing MCP transports, settings persistence, and connection lifecycle. On
top of those it adds: the preset registry and its `/mcp add` plumbing, the
`oauth: false` opt-out in both OAuth decision paths, and one narrow, generic
header-resolution safety guard that rejects a blank placeholder value
specifically for `Authorization` headers. The transport architecture was not
rebuilt and the persistence layer was not changed; header-resolution
*behavior* was narrowly changed (see the exact diff below):

```
/mcp add anysearch
        │
        ▼
resolveMcpAddArgs()            (src/cli/commands/mcp.ts — modified: preset grammar + oauth passthrough)
        │  recognizes "anysearch" as a known preset id
        ▼
resolveMcpPreset("anysearch")  (src/mcp-presets.ts — new file)
        │  builds an HttpMcpServerConfig for the current environment
        ▼
settingsManager.setMcpServers() (existing, unmodified)
        │  persists the config the same way any /mcp add does
        ▼
replaceClientMcpServers()       (src/mcp-runtime.ts — modified: honors config.oauth === false)
        │  connects via the existing Streamable HTTP MCP client
        ▼
resolveHeaderEnvironment()      (src/mcp-client.ts — modified: rejects a blank ${ENV} value for Authorization headers)
        │  substitutes ${ENV} placeholders into headers at connection time
        ▼
McpServerConfig → StreamableHTTPClientTransport (src/mcp-client.ts — modified: added the optional `oauth?: false` field to the config type)
        │
        ▼
https://api.anysearch.com/mcp
```

**Exactly which production files changed, and how:** four existing files
plus one new one.
- `src/mcp-presets.ts` — **new.** The preset registry and the AnySearch
  resolver.
- `src/cli/commands/mcp.ts` — the `/mcp add` preset grammar
  (`bareRegisteredPresetId`/`resolveMcpAddArgs`), `buildMcpServerConfig`, and
  the `oauth` passthrough from a resolved preset into the persisted config.
- `src/mcp-client.ts` — two changes. (1) One new optional field,
  `oauth?: false`, on `HttpMcpServerConfig`/`SseMcpServerConfig`. (2) A
  behavioral change to `resolveHeaderEnvironment()`: when a header's
  `${ENV}` placeholder resolves to a value that is present but empty or
  whitespace-only, and the header name is `Authorization` (case-insensitive),
  it now throws before any transport is created, instead of sending a bare
  `Bearer `. A *missing* variable throws for every header exactly as it
  always did, and a non-`Authorization` header with a blank value is
  substituted unchanged, as before. The transports themselves
  (`StreamableHTTPClientTransport`/`SSEClientTransport`/`StdioClientTransport`)
  and how they are constructed are otherwise untouched.
- `src/mcp-runtime.ts` — `oauthSessionForConfig` gained one early-return
  check, `if (config.oauth === false) return undefined;`. No change to
  connection lifecycle, error handling, or state tracking.
- `src/cli/subcommands/mcp.ts` — the headless path's independent
  `oauthForConfig` gained the identical one-line check. No change to any
  other subcommand.
- `settingsManager`'s persistence layer is unmodified — the AnySearch config
  is written and re-read by exactly the same code as any other `/mcp add`.

No new transport or tool-execution path was added anywhere. The `oauth: false`
opt-out and the blank-`Authorization` guard are both generic — neither is a
special case keyed on AnySearch — so AnySearch stays subject to the same
connection lifecycle, error handling, and settings persistence as any
manually-added MCP server. The two correctly-generalized differences from
before this change: a header-less http/sse server can now durably declare it
doesn't want OAuth, and an `Authorization` header can no longer resolve to a
blank credential on the wire.

## OAuth opt-out (`oauth: false`)

**Why this exists:** the pre-existing client-local MCP runtime treats any
http/sse server with no `Authorization` header as "probably wants OAuth" and
attempts a session for it (`oauthSessionForConfig` in `src/mcp-runtime.ts`;
the headless CLI path has its own equivalent, `oauthForConfig` in
`src/cli/subcommands/mcp.ts`). AnySearch's anonymous tier is exactly that
shape — a header-less http config. AnySearch's documented MCP connection does
not require OAuth, and its published client guidance explicitly disables
unnecessary OAuth discovery for this endpoint (see "Primary source" below), so
without an opt-out the anonymous preset would incorrectly trigger OAuth
discovery/DCR against `api.anysearch.com`.

**The fix is a new optional field, not a special case:** `HttpMcpServerConfig`
and `SseMcpServerConfig` (`src/mcp-client.ts`) gained an optional
`oauth?: false`. Both `oauthSessionForConfig` (`src/mcp-runtime.ts`, used by
the interactive `/mcp add`) and `oauthForConfig`
(`src/cli/subcommands/mcp.ts`, used by the headless `letta mcp
list/tools/call`) check `config.oauth === false` and return early with no
session, alongside their existing `hasAuthorizationHeader` check. **Both
call sites were updated** — this is not special-cased to the immediate
`/mcp add` call; the headless path would otherwise still attempt OAuth for
an anonymous AnySearch config added via settings directly.

**Default behavior for every other MCP server is unchanged**: the field is
optional and AnySearch is currently the only preset that sets it, so a
manually-added header-less http/sse server continues to get an OAuth
attempt exactly as before. The AnySearch preset (`src/mcp-presets.ts`) sets
`oauth: false` unconditionally — anonymous and authenticated alike — as
defense in depth (the `Authorization`-header check already independently
skips OAuth once a key is configured).

**Persistence:** `oauth: false` is a plain field on the config object
`settingsManager.setMcpServers`/`getMcpServers` already round-trips as JSON
with no schema that could strip it (see `stripEmptyAgentSettings` in
`src/settings-manager.ts`, which only drops an empty `mcpServers` array as a
whole, never a field inside one entry) — no persistence-layer change was
needed for the flag to survive a restart.

Tests: `src/mcp-runtime-oauth.test.ts` (interactive path) and
`src/cli/subcommands/mcp-anysearch-oauth.test.ts` (headless path) — see "How
to update or re-test this integration" below.

## Endpoint

`https://api.anysearch.com/mcp`, Streamable HTTP transport (`transport:
"http"` in `McpServerConfig` terms).

**When network contact actually happens:** `/mcp add anysearch` does not
merely save a config file. `handleMcpAdd` persists the config, then
immediately calls `replaceClientMcpServers()`, which connects and performs
the MCP `initialize`/tool-discovery handshake against the real endpoint —
before the user has run a single search. `X-Anysearch-Client` is sent on
that connection; `Authorization` too, if authenticated. Subsequent tool
calls (`search`, etc.) are separate requests on that same connection,
carrying their actual arguments. Do not describe this integration as
sending no traffic until the first search — the connection attempt itself
already talks to AnySearch's server.

## Primary source

AnySearch publishes an official MCP server reference repository:
[`anysearch-ai/anysearch-mcp-server`](https://github.com/anysearch-ai/anysearch-mcp-server).
This was fetched and read directly (`git ls-remote` + a shallow clone of its
`README.md`), not inferred — commit `e3f2701a21e61419ebd140358f0b1abb1f5ded04`
on `main`, confirmed via `git ls-remote` against the live repository. Every
fact below marked "primary-source-verified" traces to that README as read at
that commit, not to a secondary description of it.

Two details from that README are worth calling out because they
independently corroborate design decisions already made in this
integration, from an unrelated source:

- **The `oauth: false` opt-out isn't a Letta-specific invention.** The
  README's own OpenCode configuration example sets `"oauth": false` in
  OpenCode's native config format, with the comment *"`oauth: false`
  prevents an unnecessary OAuth discovery flow for this API-key-authenticated
  server."* This is the exact same interoperability problem this
  integration's `oauth: false` field solves for Letta Code's MCP runtime —
  independent confirmation that API-key-authenticated MCP servers whose
  documented connection does not require OAuth colliding with a client's
  default "assume OAuth" behavior is a real,
  recognized issue across the MCP client ecosystem, not something specific
  to how Letta Code happens to be built.
- **The env-lifecycle guidance matches an existing precedent for a
  different tool.** The README's Claude Code (Anthropic's CLI, a different
  product from Letta Code) configuration section states: *"set
  `ANYSEARCH_API_KEY` before starting Claude Code"* and explains that single
  quotes around the header value preserve the `${VAR}` reference so the
  plaintext key isn't written to that tool's config. This is the same
  set-before-starting guidance this integration's skill and docs already
  give for Letta Code, arrived at independently from reading Letta Code's
  own `resolveHeaderEnvironment()` — not copied from this source, but
  consistent with it.

## Anonymous vs. authenticated behavior

`resolveMcpPreset("anysearch", env)` inspects `env[ANYSEARCH_API_KEY_ENV]` at
the moment `/mcp add anysearch` runs:

- **Not set (or blank/whitespace-only):** the resulting config's `headers`
  object contains only `X-Anysearch-Client` — no `Authorization` key is
  added at all. This matters because of `resolveHeaderEnvironment()`'s exact
  contract in `src/mcp-client.ts`: it rejects a *missing* referenced
  environment variable for every header, and additionally rejects a
  present-but-blank (empty/whitespace-only) value only when the header name
  is `Authorization` (case-insensitive); a blank value in any other custom
  header is substituted unchanged, as it always was. An unconditional
  `Authorization` placeholder would therefore break anonymous connections in
  both the missing and the blank case. Omitting the `Authorization` header
  entirely for the anonymous case avoids both, and is what keeps
  `/mcp add anysearch` working with zero configuration.
- **Set:** `headers.Authorization` is set to the literal string
  `Bearer ${ANYSEARCH_API_KEY}` — a placeholder, not the resolved value.
  `resolveHeaderEnvironment()` substitutes the real value from
  `process.env.ANYSEARCH_API_KEY` only when the transport actually connects.
  This is the same convention `/mcp add --auth-env` already uses for any
  other server.

**Provable secret-safety claims only — not a blanket "never appears in logs anywhere" claim:**
- This integration never persists the raw `ANYSEARCH_API_KEY` value in its
  saved MCP config — only the literal `${ANYSEARCH_API_KEY}` placeholder
  string is written to `~/.letta/settings.json` (or wherever
  `settingsManager` persists to). `src/mcp-presets.test.ts` and
  `src/mcp-runtime-oauth.test.ts` assert the raw secret string is absent
  from `JSON.stringify()` of the resolved/persisted config.
- This integration's own code does not intentionally log the resolved key
  value anywhere.
- `letta mcp get`/server-detail output redacts header values (including a
  resolved `Authorization` header) through the existing, generic
  `redactValues()`/`redactUrl()` path in `src/cli/subcommands/mcp.ts`
  (covered by `src/cli/subcommands/mcp-server-details.test.ts`, "redacts
  HTTP headers and sensitive URL parameters" — reused as-is, not
  duplicated) — this is a repo-wide guarantee this integration benefits
  from, not something built specifically for AnySearch.
- No claim is made, and none should be inferred, about every other logging
  path in the wider application (e.g. verbose debug logs enabled by an
  unrelated flag, or a future logging change elsewhere in the codebase)
  because that has not been audited here and is out of this integration's
  scope.

**Key lifecycle — exact, not "set it whenever":**
- **Anonymous config created** (AnySearch added while `ANYSEARCH_API_KEY`
  was absent): no `Authorization` placeholder is persisted at all. Setting
  the environment variable *afterward* does not retroactively add the
  header — the config on disk still has no `Authorization` key, and nothing
  re-reads the environment for an already-persisted config outside of a
  fresh connection attempt using that same stored config. Moving to
  authenticated mode requires removing and re-adding the `anysearch` server
  while the Letta Code process's environment already has the key (see
  "Configuring `ANYSEARCH_API_KEY`" in the bundled skill for exactly how to
  get the key into that process's environment).
- **Authenticated config created** (key present at add-time): the persisted
  header contains only the literal `${ANYSEARCH_API_KEY}` placeholder. The
  actual value is resolved from `process.env.ANYSEARCH_API_KEY` fresh, at
  connection time, by `resolveHeaderEnvironment()` — so rotating the key's
  value does **not** require rebuilding the config, provided the Letta Code
  process has been restarted (or otherwise genuinely has the new value in
  its own environment) before the next reconnect. If the environment
  variable is missing, empty, or whitespace-only at connection time,
  `resolveHeaderEnvironment()` throws rather than silently sending an empty
  or whitespace-only `Authorization` value — the connection fails loudly
  instead of degrading to a broken anonymous-looking request.
- **Returning to anonymous**: if the persisted config already contains the
  `Authorization` placeholder and anonymous access is wanted instead, remove
  and re-add the `anysearch` server with the key genuinely absent from the
  process's environment at add-time.

This matches the pre-existing behavior of `--auth-env` exactly and is not a
gap introduced by this integration.

## `X-Anysearch-Client` header

Sent on every request, anonymous or authenticated: `letta-code/<version>`,
where `<version>` is `getVersion()` from `src/version.ts` (backed by
`package.json`'s `version` field). This mirrors the exact convention already
used for Letta's own API calls (`User-Agent: letta-code/${version}` in
`src/backend/api/http-headers.ts`), rather than inventing a new
version-stamping scheme.

**Version lifecycle — stamped once, not live-updated. Classified as an
ACCEPTED LIMITATION, not a fix-before-merge item:**

The header value is computed and written into the persisted config's
`headers` object at the moment `/mcp add anysearch` runs
(`anysearchClientHeader()` in `src/mcp-presets.ts`, called once inside
`resolveAnysearch()`). It is **not** recomputed on every future connection
or Letta Code upgrade — after upgrading Letta Code, a previously-added
`anysearch` server will keep sending the version string that was current
when it was added, until the server is removed and re-added.

This is deliberately left as-is rather than fixed, for concrete reasons, not
because it was overlooked:
- It has **no correctness or acceptance impact** — `X-Anysearch-Client` is
  purely an informational client-identification header; a stale version
  string doesn't change whether search, `get_sub_domains`, `batch_search`,
  or `extract` work.
- Every client example in AnySearch's own primary-source README (see
  "Primary source" above) — OpenCode, Claude Code, Cursor, VS Code, Cline,
  Codex, Antigravity, DeepSeek Harness, Hermes Agent, OMP — hardcodes this
  same header as a **static string in a config file**, not something
  re-resolved per connection. Stamping once at config-creation time is the
  industry-standard pattern this integration already follows, not a gap
  relative to it.
- No runtime mechanism in this repository currently re-stamps a *stored*
  MCP config's headers on upgrade, for any server. Building one exclusively
  for this one informational header would be exactly the kind of
  AnySearch-specific special case, and scope-widening for telemetry
  cosmetics, this integration has otherwise avoided throughout.

If keeping the version stamp perpetually fresh ever becomes a real
requirement (not merely a nice-to-have), it should be solved as a
repo-wide mechanism (e.g. resolving `X-Anysearch-Client` the same
placeholder way `Authorization` is resolved, at connection time rather than
add-time) rather than a one-off fix here — but nothing currently justifies
that scope increase.

## Supported MCP tools

Exposed by the upstream AnySearch MCP server itself (not implemented in this
repo): `search`, `get_sub_domains`, `batch_search`, `extract`. Letta Code
does not hardcode their input schemas anywhere in source — it only
transports the connection. Primary-source-verified parameter shapes
(`anysearch-ai/anysearch-mcp-server` README at `e3f2701a21e61419ebd140358f0b1abb1f5ded04`):

- `search`: `query` (required, natural-language), `domain`/`sub_domain`/
  `sub_domain_params` (optional, vertical — `domain`/`sub_domain` "must
  come from `get_sub_domains`", params "NEVER invent values" per that
  README's own wording), `max_results` (optional, 1–10, default 10).
- `get_sub_domains`: `domain` (single) or `domains` (array, batch up to 5,
  "preferred — covers more ground"); one of the two required. Returns a
  Markdown table (`sub_domain | description | params`).
- `batch_search`: `queries` (required, 1–5 objects, same shape as `search`).
- `extract`: `url` (required, `http://`/`https://`).

The bundled skill documents these but still explicitly instructs querying
the live tool schema (`letta mcp tools` / `tools/list`) before relying on
field names, because:

- AnySearch's **MCP** tool schema (`domain`, `sub_domain`,
  `sub_domain_params`) is **not** the same as its REST API's `tag`/`params`
  shape. Do not port REST semantics into any code or docs describing the
  MCP tools.
- If a future upstream change alters the schema after the commit cited
  above, the skill's instruction to check `tools/list` first is what keeps
  agent usage correct without requiring a Letta Code release. This
  integration was not re-verified live against the real server (see E2E
  status) — the primary-source README is the best available evidence, but
  it is still a snapshot at one commit, not a live guarantee.

## Batch semantics

Primary-source-verified: `batch_search` accepts 1–5 independent queries per
call (`queries`, each with the same fields as `search`), and *"single
failure does not block others."* Letta Code does not implement or validate
this batching logic — it is entirely upstream behavior, observed through
the MCP tool result. If re-verifying this integration once network access
allows it, confirm this directly by inspecting the actual `batch_search`
result shape for a batch containing one deliberately invalid query
alongside valid ones — the README's wording is evidence, not a substitute
for a live check.

## Extract limits

Primary-source-verified: `extract` takes an **HTML page as input** (`url`,
required) and returns its content as **Markdown**, truncated at **50,000
characters**. Do not describe `extract` as "returning HTML content" — the
output format is Markdown, not HTML. Do not document or assume support for
other input formats (PDF, DOCX, etc.) — the primary source states "HTML
pages only" and nothing in this integration overrides or extends that.

## Error visibility

No error-masking logic was added or should be added for this integration.
Errors surface however the existing MCP client/runtime already surfaces
them for any server:

- Connection failures and JSON-RPC errors: `replaceClientMcpServers()`
  returns a state with `status: "failed"` and an `error` message
  (`src/mcp-runtime.ts`); `/mcp add` reports this failure rather than
  treating a saved config as a working integration.
- Tool-level `isError` results: surfaced by the MCP client's tool-call
  result exactly as returned by the server; not intercepted or rewritten
  for AnySearch specifically.
- Auth failures / rate limits / malformed invocations: these arrive as
  whatever the AnySearch MCP server itself returns (a tool error result or
  a JSON-RPC error) — Letta Code has no AnySearch-specific error handling to
  maintain here, by design, so there is nothing that can silently swallow
  them.

Do not add AnySearch-specific error interpretation code. If AnySearch's
errors need friendlier presentation, that belongs in the generic MCP error
surfacing path (`mcp-runtime.ts`/`mcp-client.ts`), benefiting every MCP
server, not a special case for this one preset.

## Failed-add and retry semantics

This is pre-existing, generic `/mcp add` behavior in `handleMcpAdd`
(`src/cli/commands/mcp.ts`). This integration did modify that function — it
now resolves a preset, reports an unknown preset id, and builds the config
through the extracted `buildMcpServerConfig()` — but its persist-then-connect
ordering and its duplicate-name handling below are untouched, pre-existing
behavior, documented here accurately rather than silently redesigned:

- `handleMcpAdd` **persists the config to settings before attempting the
  connection**. A failed initial connection can leave the `anysearch` server
  saved with connection `status: "failed"` — a persisted config is not the
  same as a working connection (see "Error visibility" above).
- Because the name already exists in settings after that first attempt,
  simply re-running `/mcp add anysearch` is **not** the correct way to retry
  a transient failure — `handleMcpAdd` rejects it with `MCP server
  "anysearch" already exists`.
- For a transient/network retry with the same saved configuration, open the
  `/mcp` manager and use its `R` reconnect/refresh action
  (`src/cli/components/McpSelector.tsx`), not `/mcp add` again.
- Remove and re-add the server (`/mcp` manager's remove, then
  `/mcp add anysearch`) only when the **saved configuration itself** needs
  to change — for example switching anonymous ↔ authenticated mode (see
  "Key lifecycle" above), which requires a fresh config, not a reconnect of
  the old one.

## How to update or re-test this integration

1. **Preset config changes** (URL, header shape, new env var): edit
   `src/mcp-presets.ts` only. `src/mcp-presets.test.ts` covers the
   anonymous/authenticated header shape and the "never persist the secret"
   invariant — extend it alongside any change.
2. **Add-flow changes** (new preset, new `/mcp add` syntax): edit
   `resolveMcpAddArgs`/`bareRegisteredPresetId` in `src/cli/commands/mcp.ts`.
   The only preset form is a single bare registered name; everything else
   falls through to the pre-existing manual parser untouched, so no token is
   reserved and stdio child arguments (including a literal `--preset`) pass
   through exactly as before this contribution. `src/cli/commands/mcp.test.ts`
   covers preset resolution, that passthrough, and the regression guards for
   pre-existing `--transport ...` syntax — run it after any change here.
3. **Live re-verification:** export `ANYSEARCH_API_KEY` in the shell
   *before* starting Letta Code (a key exported from a Bash tool call made
   *by* an already-running agent only reaches that child process, not the
   parent Letta Code process — it will not be visible when `/mcp add`
   resolves the header), then run `letta --backend local`, then
   `/mcp add anysearch`, then `letta mcp tools` to confirm `search`,
   `get_sub_domains`, `batch_search`, and `extract` are listed, then
   `letta mcp call <tool> --args '{...}'` for a real call. This exercises
   the exact path a user goes through — do not consider a settings-only
   change sufficient evidence the integration works.
4. **OAuth opt-out changes:** edit the `oauth?: false` field on
   `HttpMcpServerConfig`/`SseMcpServerConfig` (`src/mcp-client.ts`) and its
   two independent check sites, `oauthSessionForConfig`
   (`src/mcp-runtime.ts`) and `oauthForConfig`
   (`src/cli/subcommands/mcp.ts`) — always update both, never just one.
   `src/mcp-runtime-oauth.test.ts` (interactive path) and
   `src/cli/subcommands/mcp-anysearch-oauth.test.ts` (headless path) cover
   this. `mcp-runtime-oauth.test.ts` uses a top-level `mock.module` for
   `@/mcp-oauth` and is therefore registered in
   `scripts/isolated-unit-tests.json` (per this repo's mock-isolation
   convention) — keep that entry if the file is renamed.
5. **Real persistence changes:** `src/mcp-settings.test.ts` (a pre-existing
   file, already registered in `scripts/isolated-unit-tests.json`) has a
   test, "a real disk restart preserves the AnySearch preset's oauth:false
   and never writes the raw key", that exercises the actual
   `settingsManager.setMcpServers` → `flush()` → `reset()` → `initialize()`
   → `getMcpServers()` round-trip against a real temp-HOME settings file on
   disk — not a `JSON.parse(JSON.stringify(...))` approximation — and reads
   the on-disk file directly to assert the raw test secret is absent.
   Extend this test, not a new in-memory-only one, for any future
   persistence-related claim.
6. **Regression check:** `bun test src/mcp-presets.test.ts
   src/cli/commands/mcp.test.ts src/cli/subcommands/mcp.test.ts
   src/cli/subcommands/mcp-anysearch-oauth.test.ts src/mcp-runtime.test.ts
   src/mcp-runtime-oauth.test.ts src/agent/skills-discovery.test.ts
   src/mcp-settings.test.ts`, plus the repository's canonical full-suite
   gate, `node scripts/run-unit-tests.cjs` (not raw `bun test`, which does
   not respect `scripts/isolated-unit-tests.json` and can let one suite's
   top-level module mocks or process-global state leak into unrelated
   tests), plus `bun run check` for the repo-wide static checks (skill
   frontmatter, lint, typecheck, file-size, mock isolation, etc.).

## Troubleshooting (maintainer-facing)

| Symptom | Likely cause | Where to look |
|---|---|---|
| `/mcp add anysearch` fails immediately | Network/DNS/TLS to `api.anysearch.com`, or the server rejected the initialize handshake | `replaceClientMcpServers` error surfaced by `/mcp add`; not a Letta Code bug unless the config itself is malformed |
| `/mcp add anysearch` says `MCP server "anysearch" already exists` | A prior add (successful or failed) already persisted the name | Not a bug — retry via the `/mcp` manager's `R` reconnect action for a transient failure, or remove the server first if the saved config itself needs to change |
| Anonymous connection sends a 401 | AnySearch changed its anonymous-tier policy | Re-confirm anonymous access is still supported upstream; this integration assumes it is |
| Authenticated connection fails with a valid-looking key | Either the key itself is invalid/expired upstream, or `ANYSEARCH_API_KEY` was not present in the **Letta Code process's own environment** when `/mcp add anysearch` ran — exporting it from a Bash tool call made by an already-running agent does not reach the parent process | Confirm the key was exported before Letta Code started; remove and re-add the server after fixing this |
| A documented tool name/param is wrong | Upstream changed its MCP schema | Update `src/skills/builtin/anysearch/SKILL.md`'s tool table; do not hardcode assumptions in `src/mcp-presets.ts`, which only carries connection info, not tool schemas |
| A callable tool name like `mcp__anysearch__search` doesn't work | Letta's MCP alias/collision-suffixing system assigned a different name | Run `letta mcp tools anysearch` (or `--full`) for the actual current name; never hardcode a callable name as guaranteed |
