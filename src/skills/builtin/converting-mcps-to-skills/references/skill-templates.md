# Skill Templates for MCP Servers

Use these templates when creating dedicated skills for MCP servers.

## Naming Rules (from Agent Skills spec)

The `name` field must:
- Be lowercase letters, numbers, and hyphens only (`a-z`, `0-9`, `-`)
- Be 1-64 characters
- Not start or end with a hyphen
- Not contain consecutive hyphens (`--`)
- Match the parent directory name exactly

Examples: `using-obsidian-mcp`, `mcp-filesystem`, `github-mcp`

## Simple Skill Template (Documentation Only)

Use this when:
- The MCP server has straightforward tools
- Usage patterns are simple
- No convenience wrappers needed

Keep SKILL.md under 500 lines. Move detailed docs to `references/`.

```markdown
---
name: using-<server-name>
description: <What the server does>. Use when <trigger conditions>.
# Optional fields:
# license: MIT
# compatibility: Requires network access to <service>
# metadata:
#   author: <author>
#   version: "1.0"
---

# Using <Server Name>

<Brief description of what this MCP server provides.>

## Prerequisites

- <Server requirements, e.g., "Server running at http://localhost:3001/mcp">
- <Auth requirements if any>

## Quick Start

```bash
# Set up (if auth required)
export <ENV_VAR>="your-key"

# List available tools
npx tsx ~/.letta/skills/converting-mcps-to-skills/scripts/mcp-<transport>.ts <url-or-command> list-tools

# Common operations
npx tsx ... call <tool> '{"action":"..."}'
```

## Available Tools

<List the tools with brief descriptions and example calls>

### <tool-name>
<Description>

```bash
call <tool> '{"param": "value"}'
```

## Environment Variables

- `<VAR_NAME>` - <Description>
```

---

## Rich Skill Template (With Convenience Scripts)

Use this when:
- The MCP server will be used frequently
- You want simpler command-line interface
- Server has complex auth or configuration

### Directory Structure

```
using-<server-name>/
├── SKILL.md
└── scripts/
    └── <server>.ts    # Convenience wrapper
```

### SKILL.md Template

```markdown
---
name: using-<server-name>
description: <What the server does>. Use when <trigger conditions>.
# Optional: license, compatibility, metadata (see simple template)
---

# Using <Server Name>

<Brief description>

## Prerequisites

- <Requirements>

## Quick Start

```bash
# Set API key (if needed)
export <SERVER>_API_KEY="your-key"

# List tools
npx tsx <skill-path>/scripts/<server>.ts list-tools

# Call a tool
npx tsx <skill-path>/scripts/<server>.ts <tool> '{"action":"..."}'
```

## Commands

<Document the convenience wrapper commands>

## Environment Variables

- `<SERVER>_API_KEY` - API key for authentication
- `<SERVER>_URL` - Override server URL (default: <default-url>)
```

### Convenience Wrapper Template (scripts/<server>.ts)

```typescript
#!/usr/bin/env npx tsx
/**
 * <Server Name> CLI - Convenience wrapper for <server> MCP server
 * 
 * Usage:
 *   npx tsx <server>.ts list-tools
 *   npx tsx <server>.ts <tool> '{"action":"..."}'
 */

// Configuration
const DEFAULT_URL = "<default-server-url>";
const API_KEY = process.env.<SERVER>_API_KEY;
const SERVER_URL = process.env.<SERVER>_URL || DEFAULT_URL;

// Import the parent skill's HTTP client
// For HTTP servers, you can inline the client code or import it
// For stdio, import from the parent skill

// ... implementation similar to obsidian-mcp.ts ...
// Key differences:
// - Bake in the server URL/command as defaults
// - Simplify the CLI interface for this specific server
// - Add server-specific convenience commands if needed
```

---

## Example: Simple Skill for Filesystem Server

```markdown
---
name: using-mcp-filesystem
description: Access local filesystem via MCP filesystem server. Use when user wants to read, write, or search files via MCP.
---

# Using MCP Filesystem Server

Access local files via the official MCP filesystem server.

## Quick Start

```bash
# Start by listing available tools
npx tsx ~/.letta/skills/converting-mcps-to-skills/scripts/mcp-stdio.ts \
  "npx -y @modelcontextprotocol/server-filesystem ." list-tools

# Read a file
npx tsx ... call read_file '{"path":"./README.md"}'

# List directory
npx tsx ... call list_directory '{"path":"."}'

# Search files
npx tsx ... call search_files '{"path":".","pattern":"*.ts"}'
```

## Available Tools

- `read_file` - Read file contents
- `write_file` - Write content to file
- `list_directory` - List directory contents
- `search_files` - Search for files by pattern
- `get_file_info` - Get file metadata
```

---

## Example: Rich Skill for Obsidian

See `~/.letta/skills/using-obsidian-mcp-plugin/` for a complete example of a rich skill with a convenience wrapper script.

Key features of the rich skill:
- Custom `obsidian-mcp.ts` script with defaults baked in
- Simplified CLI: just `call vault '{"action":"list"}'` 
- Environment variables for auth: `OBSIDIAN_MCP_KEY`
- Comprehensive documentation of all tools
