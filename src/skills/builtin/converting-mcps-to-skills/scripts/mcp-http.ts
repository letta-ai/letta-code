#!/usr/bin/env npx tsx
/**
 * MCP HTTP Client - Connect to any MCP server over HTTP
 *
 * Supports:
 *   - Static bearer / custom headers (--header "Authorization: Bearer ...")
 *   - OAuth 2.1 with PKCE + dynamic client registration (auto or --auth oauth)
 *
 * Usage:
 *   npx tsx mcp-http.ts <url> [options] <command> [args]
 *
 * Commands:
 *   list-tools              List available tools
 *   list-resources          List available resources
 *   info <tool>             Show tool schema
 *   call <tool> '<json>'    Call a tool with JSON arguments
 *   login                   Run OAuth flow and cache tokens for this server
 *   logout                  Clear cached OAuth tokens for this server
 *
 * Options:
 *   --header, -H "K: V"     Add HTTP header (repeatable). Disables auto-OAuth.
 *   --auth <mode>           "auto" (default), "oauth", or "none"
 *   --timeout <ms>          Request timeout (default: 30000)
 *   --help, -h              Show this help
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";

// -------------------- Types --------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: object;
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}

interface ParsedArgs {
  url: string;
  command: string;
  commandArgs: string[];
  headers: Record<string, string>;
  authMode: "auto" | "oauth" | "none";
  timeoutMs: number;
}

interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  registration_access_token?: string;
  registration_client_uri?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
}

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  expires_at?: number; // epoch seconds
}

interface CachedAuth {
  server_url: string;
  authorization_server: string;
  metadata: OAuthServerMetadata;
  client: RegisteredClient;
  tokens?: TokenSet;
}

// -------------------- Arg parsing --------------------

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const headers: Record<string, string> = {};
  let url = "";
  let command = "";
  const commandArgs: string[] = [];
  let authMode: "auto" | "oauth" | "none" = "auto";
  let timeoutMs = 30000;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg === "--header" || arg === "-H") {
      const headerValue = args[++i];
      if (headerValue) {
        const colonIndex = headerValue.indexOf(":");
        if (colonIndex > 0) {
          const key = headerValue.slice(0, colonIndex).trim();
          const value = headerValue.slice(colonIndex + 1).trim();
          headers[key] = value;
        }
      }
    } else if (arg === "--auth") {
      const v = args[++i];
      if (v === "auto" || v === "oauth" || v === "none") authMode = v;
    } else if (arg === "--timeout") {
      const v = args[++i];
      if (v) timeoutMs = Number(v) || timeoutMs;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!url && arg.startsWith("http")) {
      url = arg;
    } else if (!command) {
      command = arg;
    } else {
      commandArgs.push(arg);
    }
    i++;
  }

  return { url, command, commandArgs, headers, authMode, timeoutMs };
}

// -------------------- Token cache --------------------

function cacheDir(): string {
  const dir = path.join(os.homedir(), ".letta", "mcp-oauth");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function cachePathForUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  // Include host + path so different MCP servers on the same host stay separate.
  const key = `${u.host}${u.pathname}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(cacheDir(), `${key}.json`);
}

function loadCache(serverUrl: string): CachedAuth | null {
  const p = cachePathForUrl(serverUrl);
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as CachedAuth;
  } catch {
    return null;
  }
}

function saveCache(serverUrl: string, data: CachedAuth): void {
  const p = cachePathForUrl(serverUrl);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
}

function clearCache(serverUrl: string): boolean {
  const p = cachePathForUrl(serverUrl);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// -------------------- OAuth helpers --------------------

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

/**
 * Parse `WWW-Authenticate: Bearer realm="...", resource_metadata="..."` etc.
 * Returns a flat map of params. Case-insensitive keys.
 */
function parseWwwAuthenticate(header: string): Record<string, string> {
  const idx = header.indexOf(" ");
  const params = idx >= 0 ? header.slice(idx + 1) : header;
  const out: Record<string, string> = {};
  const re =
    /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"|([a-zA-Z0-9_-]+)\s*=\s*([^,\s]+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
  while ((m = re.exec(params))) {
    const key = (m[1] || m[3] || "").toLowerCase();
    const val = m[2] ?? m[4] ?? "";
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Given an MCP server URL and a 401 WWW-Authenticate value, discover the OAuth
 * authorization server metadata. Prefers `resource_metadata` when present, then
 * falls back to `realm`, then to the server's own origin.
 */
async function discoverAuthServer(
  serverUrl: string,
  wwwAuth: string | null,
): Promise<{ authServer: string; metadata: OAuthServerMetadata }> {
  const candidates: string[] = [];
  const params = wwwAuth ? parseWwwAuthenticate(wwwAuth) : {};

  if (params.resource_metadata) {
    try {
      const rm = await fetchJson<{ authorization_servers?: string[] }>(
        params.resource_metadata,
      );
      if (rm.authorization_servers?.length) {
        candidates.push(...rm.authorization_servers);
      }
    } catch {
      /* fall through */
    }
  }
  if (params.realm) candidates.push(params.realm);
  candidates.push(new URL(serverUrl).origin);

  const tried: string[] = [];
  for (const issuer of candidates) {
    const base = issuer.replace(/\/$/, "");
    const wellKnowns = [
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`,
    ];
    for (const w of wellKnowns) {
      tried.push(w);
      try {
        const metadata = await fetchJson<OAuthServerMetadata>(w);
        if (metadata.authorization_endpoint && metadata.token_endpoint) {
          return { authServer: base, metadata };
        }
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(
    `Could not discover OAuth server metadata. Tried:\n  ${tried.join("\n  ")}`,
  );
}

async function registerClient(
  metadata: OAuthServerMetadata,
  redirectUri: string,
): Promise<RegisteredClient> {
  if (!metadata.registration_endpoint) {
    throw new Error(
      `Auth server has no registration_endpoint. Manual client registration is required; ` +
        `pass a client_id via a static bearer header instead.`,
    );
  }
  const body = {
    client_name: "letta-code mcp-http",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none", // public client (PKCE)
    application_type: "native",
  };
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Dynamic client registration failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(text) as RegisteredClient;
  return {
    client_id: parsed.client_id,
    client_secret: parsed.client_secret,
    registration_access_token: parsed.registration_access_token,
    registration_client_uri: parsed.registration_client_uri,
    redirect_uris: parsed.redirect_uris || [redirectUri],
    token_endpoint_auth_method: parsed.token_endpoint_auth_method || "none",
  };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can copy the URL from stderr */
  }
}

interface LoopbackResult {
  code: string;
  state: string;
}

interface LoopbackListener {
  port: number;
  done: Promise<LoopbackResult>;
}

function startLoopback(expectedState: string): Promise<LoopbackListener> {
  return new Promise((resolveOuter, rejectOuter) => {
    let resolveDone!: (r: LoopbackResult) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<LoopbackResult>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404).end("not found");
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          rejectDone(new Error(`Authorization error: ${error}`));
          return;
        }
        if (!code || !state) {
          res.writeHead(400).end("missing code or state");
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400).end("state mismatch");
          server.close();
          rejectDone(new Error("OAuth state mismatch"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>Signed in.</h1><p>You can close this tab and return to the terminal.</p></body></html>`,
        );
        server.close();
        resolveDone({ code, state });
      } catch (e) {
        rejectDone(e as Error);
      }
    });
    server.on("error", (e) => {
      rejectDone(e);
      rejectOuter(e);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolveOuter({ port, done });
    });
  });
}

async function exchangeCodeForTokens(
  metadata: OAuthServerMetadata,
  client: RegisteredClient,
  code: string,
  verifier: string,
  redirectUri: string,
  resource: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource,
  });
  if (client.client_secret) body.set("client_secret", client.client_secret);

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
  };
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    token_type: parsed.token_type || "Bearer",
    scope: parsed.scope,
    expires_at: parsed.expires_in ? now + parsed.expires_in - 30 : undefined,
  };
}

async function refreshTokens(
  metadata: OAuthServerMetadata,
  client: RegisteredClient,
  refreshToken: string,
  resource: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.client_id,
    resource,
  });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token refresh failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
  };
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token || refreshToken,
    token_type: parsed.token_type || "Bearer",
    scope: parsed.scope,
    expires_at: parsed.expires_in ? now + parsed.expires_in - 30 : undefined,
  };
}

async function runOAuthLogin(
  serverUrl: string,
  wwwAuth: string | null,
): Promise<CachedAuth> {
  process.stderr.write(`Discovering OAuth for ${serverUrl}...\n`);
  const { authServer, metadata } = await discoverAuthServer(serverUrl, wwwAuth);
  process.stderr.write(`Authorization server: ${authServer}\n`);

  const state = b64url(crypto.randomBytes(16));
  const { verifier, challenge } = makePkce();

  const listener = await startLoopback(state);
  const redirectUri = `http://127.0.0.1:${listener.port}/callback`;

  process.stderr.write(`Registering client dynamically...\n`);
  const client = await registerClient(metadata, redirectUri);

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", serverUrl);
  const scopes = metadata.scopes_supported?.includes("offline_access")
    ? "openid offline_access"
    : "openid";
  authUrl.searchParams.set("scope", scopes);

  process.stderr.write(
    `Opening browser to sign in:\n  ${authUrl.toString()}\n`,
  );
  openBrowser(authUrl.toString());

  const result = await listener.done;
  process.stderr.write(`Exchanging code for tokens...\n`);
  const tokens = await exchangeCodeForTokens(
    metadata,
    client,
    result.code,
    verifier,
    redirectUri,
    serverUrl,
  );

  const cache: CachedAuth = {
    server_url: serverUrl,
    authorization_server: authServer,
    metadata,
    client,
    tokens,
  };
  saveCache(serverUrl, cache);
  process.stderr.write(
    `Signed in. Tokens cached at ${cachePathForUrl(serverUrl)}\n`,
  );
  return cache;
}

async function ensureAccessToken(cache: CachedAuth): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tokens = cache.tokens;
  if (!tokens) throw new Error("No tokens in cache; run `login`.");
  if (!tokens.expires_at || tokens.expires_at > now) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Access token expired and no refresh token; run `login` again.",
    );
  }
  const fresh = await refreshTokens(
    cache.metadata,
    cache.client,
    tokens.refresh_token,
    cache.server_url,
  );
  cache.tokens = fresh;
  saveCache(cache.server_url, cache);
  return fresh.access_token;
}

// -------------------- MCP session --------------------

let sessionId: string | null = null;
let initialized = false;
let requestHeaders: Record<string, string> = {};
let serverUrl = "";
let timeoutMs = 30000;
let authMode: "auto" | "oauth" | "none" = "auto";
let currentAuth: CachedAuth | null = null;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function rawMcpRequest(
  method: string,
  params?: object,
  opts: { allowOAuth?: boolean } = {},
): Promise<{ response: JsonRpcResponse; newSessionId?: string }> {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params,
    id: Date.now(),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...requestHeaders,
  };

  // If we have an OAuth token and no explicit Authorization header, attach it.
  if (!headers.Authorization && currentAuth?.tokens) {
    const access = await ensureAccessToken(currentAuth);
    headers.Authorization = `Bearer ${access}`;
  }

  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  let fetchResponse: Response;
  try {
    fetchResponse = await fetchWithTimeout(serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error(
        `Cannot connect to ${serverUrl}\nIs the MCP server running?`,
      );
    }
    throw error;
  }

  const newSessionId = fetchResponse.headers.get("Mcp-Session-Id") || undefined;

  if (fetchResponse.status === 401) {
    const wwwAuth = fetchResponse.headers.get("www-authenticate");
    const hasStaticAuth = Boolean(requestHeaders.Authorization);
    const canOAuth =
      opts.allowOAuth !== false &&
      !hasStaticAuth &&
      (authMode === "oauth" ||
        (authMode === "auto" && wwwAuth?.toLowerCase().startsWith("bearer")));

    if (canOAuth) {
      await fetchResponse.text().catch(() => "");
      if (!currentAuth) currentAuth = loadCache(serverUrl);
      if (currentAuth?.tokens?.refresh_token) {
        try {
          currentAuth.tokens = await refreshTokens(
            currentAuth.metadata,
            currentAuth.client,
            currentAuth.tokens.refresh_token,
            serverUrl,
          );
          saveCache(serverUrl, currentAuth);
        } catch {
          currentAuth = await runOAuthLogin(serverUrl, wwwAuth);
        }
      } else {
        currentAuth = await runOAuthLogin(serverUrl, wwwAuth);
      }
      return rawMcpRequest(method, params, { allowOAuth: false });
    }

    const text = await fetchResponse.text().catch(() => "");
    throw new Error(
      `Authentication required (401).${
        wwwAuth ? ` WWW-Authenticate: ${wwwAuth}` : ""
      }\n${text}\n` +
        `Add --header "Authorization: Bearer YOUR_KEY", or run \`login\` first, or pass --auth oauth.`,
    );
  }

  if (!fetchResponse.ok) {
    const text = await fetchResponse.text();
    try {
      const errorResponse = JSON.parse(text) as JsonRpcResponse;
      return { response: errorResponse, newSessionId };
    } catch {
      throw new Error(
        `HTTP ${fetchResponse.status}: ${fetchResponse.statusText}\n${text}`,
      );
    }
  }

  const contentType = fetchResponse.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const jsonResponse = (await fetchResponse.json()) as JsonRpcResponse;
    return { response: jsonResponse, newSessionId };
  }

  if (contentType.includes("text/event-stream")) {
    const text = await fetchResponse.text();
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));

    for (let i = dataLines.length - 1; i >= 0; i--) {
      const line = dataLines[i];
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.jsonrpc === "2.0") {
          return { response: parsed as JsonRpcResponse, newSessionId };
        }
      } catch {
        /* continue */
      }
    }
    throw new Error("No valid JSON-RPC response found in SSE stream");
  }

  throw new Error(`Unexpected content type: ${contentType}`);
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  const { response, newSessionId } = await rawMcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-http-cli", version: "1.1.0" },
  });
  if (newSessionId) sessionId = newSessionId;
  if (response.error) {
    throw new Error(`Initialization failed: ${response.error.message}`);
  }
  await rawMcpRequest("notifications/initialized", {});
  initialized = true;
}

async function mcpRequest(
  method: string,
  params?: object,
): Promise<JsonRpcResponse> {
  await ensureInitialized();
  const { response, newSessionId } = await rawMcpRequest(method, params);
  if (newSessionId) sessionId = newSessionId;
  return response;
}

// -------------------- Commands --------------------

async function listTools(): Promise<void> {
  const response = await mcpRequest("tools/list");
  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }
  const result = response.result as {
    tools: Array<{ name: string; description: string; inputSchema: object }>;
  };
  console.log("Available tools:\n");
  for (const tool of result.tools) {
    console.log(`  ${tool.name}`);
    if (tool.description) console.log(`    ${tool.description}\n`);
    else console.log();
  }
  console.log(`\nTotal: ${result.tools.length} tools`);
  console.log("\nUse 'call <tool> <json-args>' to invoke a tool");
}

async function listResources(): Promise<void> {
  const response = await mcpRequest("resources/list");
  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }
  const result = response.result as {
    resources: Array<{ uri: string; name: string; description?: string }>;
  };
  if (!result.resources || result.resources.length === 0) {
    console.log("No resources available.");
    return;
  }
  console.log("Available resources:\n");
  for (const resource of result.resources) {
    console.log(`  ${resource.uri}`);
    console.log(`    ${resource.name}`);
    if (resource.description) console.log(`    ${resource.description}`);
    console.log();
  }
}

async function callTool(toolName: string, argsJson: string): Promise<void> {
  let args: object;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    console.error(`Invalid JSON: ${argsJson}`);
    process.exit(1);
  }
  const response = await mcpRequest("tools/call", {
    name: toolName,
    arguments: args,
  });
  if (response.error) {
    console.error("Error:", response.error.message);
    if (response.error.data) {
      console.error("Details:", JSON.stringify(response.error.data, null, 2));
    }
    process.exit(1);
  }
  console.log(JSON.stringify(response.result, null, 2));
}

async function getToolSchema(toolName: string): Promise<void> {
  const response = await mcpRequest("tools/list");
  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }
  const result = response.result as {
    tools: Array<{ name: string; description: string; inputSchema: object }>;
  };
  const tool = result.tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`Tool not found: ${toolName}`);
    console.error(
      `Available tools: ${result.tools.map((t) => t.name).join(", ")}`,
    );
    process.exit(1);
  }
  console.log(`Tool: ${tool.name}\n`);
  if (tool.description) console.log(`Description: ${tool.description}\n`);
  console.log("Input Schema:");
  console.log(JSON.stringify(tool.inputSchema, null, 2));
}

async function loginCommand(): Promise<void> {
  let wwwAuth: string | null = null;
  try {
    const res = await fetchWithTimeout(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-http-cli", version: "1.1.0" },
        },
        id: 1,
      }),
    });
    wwwAuth = res.headers.get("www-authenticate");
  } catch {
    /* proceed anyway */
  }
  await runOAuthLogin(serverUrl, wwwAuth);
}

function logoutCommand(): void {
  const removed = clearCache(serverUrl);
  console.log(
    removed
      ? `Cleared cached tokens for ${serverUrl}`
      : `No cached tokens for ${serverUrl}`,
  );
}

function printUsage(): void {
  console.log(`MCP HTTP Client - Connect to any MCP server over HTTP

Usage: npx tsx mcp-http.ts <url> [options] <command> [args]

Commands:
  list-tools              List available tools with descriptions
  list-resources          List available resources
  info <tool>             Show tool schema/parameters
  call <tool> '<json>'    Call a tool with JSON arguments
  login                   Run OAuth flow and cache tokens for this server
  logout                  Clear cached OAuth tokens for this server

Options:
  --header, -H "K: V"     Add HTTP header (repeatable). Disables auto-OAuth.
  --auth <mode>           "auto" (default), "oauth", or "none"
  --timeout <ms>          Request timeout (default: 30000)
  --help, -h              Show this help

Authentication:
  Static bearer:  --header "Authorization: Bearer YOUR_KEY"
  OAuth 2.1:      Just run any command; a 401 with WWW-Authenticate triggers
                  browser-based login via PKCE + dynamic client registration.
                  Tokens are cached at ~/.letta/mcp-oauth/ and auto-refreshed.

Examples:
  npx tsx mcp-http.ts http://localhost:3001/mcp list-tools
  npx tsx mcp-http.ts https://example.com/mcp login
  npx tsx mcp-http.ts https://example.com/mcp list-tools
  npx tsx mcp-http.ts https://example.com/mcp call some_tool '{"x":1}'
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs();

  if (!parsed.url) {
    console.error("Error: URL is required\n");
    printUsage();
    process.exit(1);
  }

  serverUrl = parsed.url;
  requestHeaders = parsed.headers;
  timeoutMs = parsed.timeoutMs;
  authMode = parsed.authMode;
  currentAuth = authMode === "none" ? null : loadCache(serverUrl);

  if (!parsed.command) {
    console.error("Error: Command is required\n");
    printUsage();
    process.exit(1);
  }

  try {
    switch (parsed.command) {
      case "list-tools":
        await listTools();
        break;
      case "list-resources":
        await listResources();
        break;
      case "info": {
        const [toolName] = parsed.commandArgs;
        if (!toolName) {
          console.error("Error: Tool name required\nUsage: info <tool>");
          process.exit(1);
        }
        await getToolSchema(toolName);
        break;
      }
      case "call": {
        const [toolName, argsJson] = parsed.commandArgs;
        if (!toolName) {
          console.error(
            "Error: Tool name required\nUsage: call <tool> '<json-args>'",
          );
          process.exit(1);
        }
        await callTool(toolName, argsJson || "{}");
        break;
      }
      case "login":
        await loginCommand();
        break;
      case "logout":
        logoutCommand();
        break;
      default:
        console.error(`Unknown command: ${parsed.command}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
