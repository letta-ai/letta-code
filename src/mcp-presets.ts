// Built-in MCP server presets surfaced through `/mcp add <preset>`.
// Presets remove the need to hand-construct an
// McpServerConfig for integrations Letta Code ships support for out of the
// box; they resolve to the same McpServerConfig shape a manual
// `/mcp add --transport ...` invocation produces, so they flow through the
// existing settings + client-local MCP runtime unchanged.

import type { HttpMcpServerConfig } from "@/mcp-client";
import { getVersion } from "@/version";

/** Header AnySearch uses to identify which client/version is calling it. */
export const ANYSEARCH_CLIENT_HEADER = "X-Anysearch-Client";

/** Optional API key environment variable for authenticated AnySearch access. */
export const ANYSEARCH_API_KEY_ENV = "ANYSEARCH_API_KEY";

/** Upstream AnySearch MCP endpoint (Streamable HTTP transport). */
export const ANYSEARCH_MCP_URL = "https://api.anysearch.com/mcp";

export interface McpPresetDefinition {
  /** Preset id; also used as the server name when added. */
  id: string;
  /** One-line summary shown in `/mcp add` help and preset listings. */
  description: string;
  /** Build the McpServerConfig for this preset against the given environment. */
  resolve: (env: NodeJS.ProcessEnv) => HttpMcpServerConfig;
}

function anysearchClientHeader(): string {
  return `letta-code/${getVersion()}`;
}

/**
 * AnySearch is optional-key: an unset/blank ANYSEARCH_API_KEY yields an
 * anonymous config with no Authorization header at all (never an empty or
 * placeholder-only header). When the key is present at add-time, the header
 * stores the `${ANYSEARCH_API_KEY}` placeholder — the same convention
 * `--auth-env` already uses. Evidence-bounded claim (see
 * docs/integrations/anysearch.md for the full scope of what this proves and
 * doesn't): the raw key is not persisted in this preset's saved MCP config —
 * only the `${ANYSEARCH_API_KEY}` placeholder is — and this code does not
 * intentionally log the resolved value. The real value is resolved from the
 * environment only at connection time (see resolveHeaderEnvironment in
 * src/mcp-client.ts). No claim is made about every other logging/snapshot
 * path in the wider application.
 *
 * `oauth: false` is set unconditionally (anonymous or authenticated):
 * AnySearch's documented MCP connection does not require OAuth and its
 * published client guidance explicitly disables unnecessary OAuth discovery
 * for this endpoint (see docs/integrations/anysearch.md, "Primary source"). A
 * header-less http config is otherwise assumed by the client-local runtime
 * to want an OAuth session (see oauthSessionForConfig in mcp-runtime.ts /
 * oauthForConfig in cli/subcommands/mcp.ts) — without this, the anonymous
 * preset would incorrectly trigger OAuth discovery/DCR against AnySearch.
 */
function resolveAnysearch(env: NodeJS.ProcessEnv): HttpMcpServerConfig {
  const headers: Record<string, string> = {
    [ANYSEARCH_CLIENT_HEADER]: anysearchClientHeader(),
  };

  if (env[ANYSEARCH_API_KEY_ENV]?.trim()) {
    headers.Authorization = `Bearer \${${ANYSEARCH_API_KEY_ENV}}`;
  }

  return {
    name: "anysearch",
    transport: "http",
    url: ANYSEARCH_MCP_URL,
    headers,
    oauth: false,
  };
}

export const MCP_SERVER_PRESETS: Record<string, McpPresetDefinition> = {
  anysearch: {
    id: "anysearch",
    description:
      "AnySearch: general/anonymous/authenticated web search, sub-domain discovery, batch search, and page extraction",
    resolve: resolveAnysearch,
  },
};

/**
 * Look up and resolve a built-in MCP preset by id, if one exists.
 * `Object.hasOwn` guards against inherited `Object.prototype` names
 * (`toString`, `constructor`, `hasOwnProperty`, `__proto__`, ...) being
 * mistaken for a registered preset via plain bracket lookup.
 */
export function resolveMcpPreset(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): HttpMcpServerConfig | undefined {
  if (!Object.hasOwn(MCP_SERVER_PRESETS, id)) return undefined;
  return MCP_SERVER_PRESETS[id]?.resolve(env);
}

/** List all built-in MCP presets, for help text and discovery. */
export function listMcpPresets(): McpPresetDefinition[] {
  return Object.values(MCP_SERVER_PRESETS);
}
