---
name: converting-mcps-to-skills
description: Connect to MCP (Model Context Protocol) servers and create skills for repeated use. Load when a user wants to use an MCP server, connect to external tools via MCP, or when they mention MCP, model context protocol, or specific MCP servers.
---

# Converting MCP Servers to Skills

Letta Code is not itself an MCP client, but as a general computer-use agent, you can easily connect to any MCP server using the scripts in this skill.

## What is MCP?

MCP (Model Context Protocol) is a standard for exposing tools to AI agents. MCP servers provide tools via JSON-RPC, either over:
- **HTTP** - Server running at a URL (e.g., `http://localhost:3001/mcp`)
- **stdio** - Server runs as a subprocess, communicating via stdin/stdout

## Quick Start: Connecting to an MCP Server

### Step 1: Determine the transport type

Ask the user:
- Is it an HTTP server (has a URL)?
- Is it a stdio server (runs via command like `npx`, `node`, `python`)?

### Step 2: Test the connection

**For HTTP servers:**
```bash
npx tsx <SKILL_DIR>/scripts/mcp-http.ts <url> list-tools

# With auth header
npx tsx <SKILL_DIR>/scripts/mcp-http.ts <url> --header "Authorization: Bearer KEY" list-tools
```
Where `<SKILL_DIR>` is the Skill Directory shown when the skill was loaded (visible in the injection header).

**For stdio servers:**
```bash
npx tsx <SKILL_DIR>/scripts/mcp-stdio.ts "<command>" list-tools

# Examples
npx tsx <SKILL_DIR>/scripts/mcp-stdio.ts "npx -y @modelcontextprotocol/server-filesystem ." list-tools
npx tsx <SKILL_DIR>/scripts/mcp-stdio.ts "python server.py" list-tools
```

### Step 3: Explore available tools

```bash
# List all tools
... list-tools

# Get schema for a specific tool
... info <tool-name>

# Test calling a tool
... call <tool-name> '{"arg": "value"}'
```

## Creating a Dedicated Skill

When an MCP server will be used repeatedly, create a dedicated skill for it. This makes future use easier and documents the server's capabilities.

### Decision: Simple vs Rich Skill

**Simple skill** (just SKILL.md):
- Good for straightforward servers
- Documents how to use the parent skill's scripts with this specific server
- No additional scripts needed

**Rich skill** (SKILL.md + scripts/):
- Good for frequently-used servers
- Includes convenience wrapper scripts with defaults baked in
- Provides a simpler interface than the generic scripts

See `references/skill-templates.md` for templates.

## Built-in Scripts Reference

### mcp-http.ts - HTTP Transport

Connects to MCP servers over HTTP. No dependencies required.

```bash
npx tsx mcp-http.ts <url> [options] <command> [args]

Commands:
  list-tools              List available tools
  list-resources          List available resources
  info <tool>             Show tool schema
  call <tool> '<json>'    Call a tool
  login                   Run OAuth flow and cache tokens for this server
  logout                  Clear cached OAuth tokens for this server

Options:
  --header "K: V"         Add HTTP header (repeatable). Disables auto-OAuth.
  --auth <mode>           "auto" (default), "oauth", or "none"
  --timeout <ms>          Request timeout (default: 30000)
```

**Examples:**
```bash
# Basic usage
npx tsx mcp-http.ts http://localhost:3001/mcp list-tools

# With static bearer authentication
npx tsx mcp-http.ts http://localhost:3001/mcp --header "Authorization: Bearer KEY" list-tools

# OAuth-protected server (opens a browser to sign in, then caches tokens)
npx tsx mcp-http.ts https://example.com/mcp login
npx tsx mcp-http.ts https://example.com/mcp list-tools

# Call a tool
npx tsx mcp-http.ts http://localhost:3001/mcp call vault '{"action":"search","query":"notes"}'
```

**OAuth support:**
When a server returns `401 WWW-Authenticate: Bearer ...` and no static
`Authorization` header was supplied, `mcp-http.ts` will automatically:

1. Discover the authorization server via `resource_metadata`, the
   `realm=` param, or the server's own origin (`.well-known/oauth-authorization-server`
   then `.well-known/openid-configuration`).
2. Dynamically register a public client with PKCE (`token_endpoint_auth_method: none`).
3. Open the system browser to the authorization endpoint, catch the redirect
   on a `127.0.0.1` loopback port, and exchange the code for tokens.
4. Cache the token set (and the registered client) at
   `~/.letta/mcp-oauth/<host>_<path>.json` with `0600` perms.
5. Auto-refresh expired access tokens using the stored refresh token before
   each request; if refresh fails, it re-runs the browser flow once.

Use `login` to run the flow explicitly (e.g. as a first step in a skill's
setup) and `logout` to clear cached tokens. Passing an explicit
`--header "Authorization: ..."` disables auto-OAuth so you stay in control.
Pass `--auth none` to force static-only behavior.

### mcp-stdio.ts - stdio Transport

Connects to MCP servers that run as subprocesses. No dependencies required.

```bash
npx tsx mcp-stdio.ts "<command>" [options] <action> [args]

Actions:
  list-tools              List available tools
  list-resources          List available resources
  info <tool>             Show tool schema
  call <tool> '<json>'    Call a tool

Options:
  --env "KEY=VALUE"       Set environment variable (repeatable)
  --cwd <path>            Set working directory
  --timeout <ms>          Request timeout (default: 30000)
```

**Examples:**
```bash
# Filesystem server
npx tsx mcp-stdio.ts "npx -y @modelcontextprotocol/server-filesystem ." list-tools

# With environment variable
npx tsx mcp-stdio.ts "node server.js" --env "API_KEY=xxx" list-tools

# Call a tool
npx tsx mcp-stdio.ts "python server.py" call read_file '{"path":"./README.md"}'
```

## Common MCP Servers

Here are some well-known MCP servers:

| Server | Transport | Command/URL |
|--------|-----------|-------------|
| Filesystem | stdio | `npx -y @modelcontextprotocol/server-filesystem <path>` |
| GitHub | stdio | `npx -y @modelcontextprotocol/server-github` |
| Brave Search | stdio | `npx -y @modelcontextprotocol/server-brave-search` |
| obsidian-mcp-plugin | HTTP | `http://localhost:3001/mcp` |

## Troubleshooting

**"Cannot connect" error:**
- For HTTP: Check the URL is correct and server is running
- For stdio: Check the command works when run directly in terminal

**"Authentication required" error:**
- Add `--header "Authorization: Bearer YOUR_KEY"` for HTTP servers using static bearers
- Or `--env "API_KEY=xxx"` for stdio servers that need env vars
- For OAuth-protected HTTP servers, just run any command (or `login`) — the helper
  will do PKCE + dynamic client registration and cache tokens under
  `~/.letta/mcp-oauth/`. Delete that file (or run `logout`) to force a re-login.

**OAuth issues:**
- "Could not discover OAuth server metadata": the server didn't include
  `resource_metadata` and its origin doesn't serve `.well-known/oauth-authorization-server`
  or `.well-known/openid-configuration`. Fall back to a static bearer, or point the
  helper at the auth server manually via a custom skill.
- "Dynamic client registration failed": the auth server disables open DCR.
  You'll need to pre-register a client and pass its `client_id` (and any required
  credentials) via headers, or wrap this skill with a server-specific one.
- "state mismatch" / callback timeout: another process may be holding the browser
  callback; re-run and complete the sign-in in the newly opened tab.

**Tool call fails:**
- Use `info <tool>` to see the expected input schema
- Ensure JSON arguments match the schema
