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
npx tsx <skill-path>/scripts/mcp-http.ts <url> list-tools

# With auth header
npx tsx <skill-path>/scripts/mcp-http.ts <url> --header "Authorization: Bearer KEY" list-tools
```

**For stdio servers:**
```bash
# First, install dependencies (one time)
cd <skill-path>/scripts && npm install

# Then connect
npx tsx <skill-path>/scripts/mcp-stdio.ts "<command>" list-tools

# Examples
npx tsx <skill-path>/scripts/mcp-stdio.ts "npx -y @modelcontextprotocol/server-filesystem ." list-tools
npx tsx <skill-path>/scripts/mcp-stdio.ts "python server.py" list-tools
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

Options:
  --header "K: V"         Add HTTP header (repeatable)
  --timeout <ms>          Request timeout (default: 30000)
```

**Examples:**
```bash
# Basic usage
npx tsx mcp-http.ts http://localhost:3001/mcp list-tools

# With authentication
npx tsx mcp-http.ts http://localhost:3001/mcp --header "Authorization: Bearer KEY" list-tools

# Call a tool
npx tsx mcp-http.ts http://localhost:3001/mcp call vault '{"action":"search","query":"notes"}'
```

### mcp-stdio.ts - stdio Transport

Connects to MCP servers that run as subprocesses. Requires npm install first.

```bash
# One-time setup
cd <skill-path>/scripts && npm install

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
- Add `--header "Authorization: Bearer YOUR_KEY"` for HTTP
- Or `--env "API_KEY=xxx"` for stdio servers that need env vars

**stdio "npm install" error:**
- Run `cd <skill-path>/scripts && npm install` first
- The stdio client requires the MCP SDK

**Tool call fails:**
- Use `info <tool>` to see the expected input schema
- Ensure JSON arguments match the schema
