# Skill Templates for MCP Servers

When to create a dedicated skill:
- **One-off use**: No skill needed - just use `converting-mcps-to-skills` scripts directly
- **Repeated use**: Create a self-contained skill with customized scripts

Skills should be self-contained per the [Agent Skills spec](https://agentskills.io/specification).

## Naming Rules (from Agent Skills spec)

The `name` field must:
- Be lowercase letters, numbers, and hyphens only (`a-z`, `0-9`, `-`)
- Be 1-64 characters
- Not start or end with a hyphen
- Not contain consecutive hyphens (`--`)
- Match the parent directory name exactly

Examples: `using-github-mcp`, `mcp-filesystem`, `slack-mcp`

## Skill Template

Use this template when creating a self-contained skill for an MCP server.

### Directory Structure

```
using-<server-name>/
├── SKILL.md
└── scripts/
    └── <server>.ts    # Customized client (copied from converting-mcps-to-skills)
```

### SKILL.md Template

```markdown
---
name: using-<server-name>
description: <What the server does>. Use when <trigger conditions>.
# Optional fields:
# license: MIT
# compatibility: Requires network access to <service>
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
npx tsx <skill-path>/scripts/<server>.ts call <tool> '{"arg":"value"}'
```

## Available Tools

<Document tools with examples>

## Environment Variables

- `<SERVER>_API_KEY` - API key for authentication
- `<SERVER>_URL` - Override server URL (default: <default-url>)
```

### Script Template (scripts/<server>.ts)

Copy the HTTP client from `converting-mcps-to-skills/scripts/mcp-http.ts` (or `mcp-stdio.ts` for stdio servers) and customize:

1. Set `DEFAULT_URL` to this server's URL
2. Rename the API key env var (e.g., `GITHUB_MCP_KEY` instead of generic)
3. Optionally simplify the CLI for common operations

The copied code is self-contained - no external dependencies for HTTP transport.

```typescript
#!/usr/bin/env npx tsx
/**
 * <Server Name> CLI - Self-contained MCP client
 */

// Customize these for your server
const DEFAULT_URL = "<server-url>";
const API_KEY = process.env.<SERVER>_API_KEY;

// Copy the rest of mcp-http.ts here and adjust as needed
// ...
```

## Example: Self-Contained Filesystem Skill

A complete example of a self-contained skill for the MCP filesystem server:

```
using-mcp-filesystem/
├── SKILL.md
└── scripts/
    └── filesystem.ts    # Copied and customized from mcp-stdio.ts
```

**SKILL.md:**
```markdown
---
name: using-mcp-filesystem
description: Access local filesystem via MCP. Use when user wants to read, write, or search files via MCP protocol.
---

# Using MCP Filesystem Server

Access local files via the official MCP filesystem server.

## Quick Start

```bash
npx tsx <skill-path>/scripts/filesystem.ts list-tools
npx tsx <skill-path>/scripts/filesystem.ts call read_file '{"path":"./README.md"}'
```

## Available Tools

- `read_file` - Read file contents
- `write_file` - Write content to file
- `list_directory` - List directory contents
- `search_files` - Search for files by pattern
- `get_file_info` - Get file metadata
```

**scripts/filesystem.ts:**
Copy `converting-mcps-to-skills/scripts/mcp-stdio.ts` and set the default command to:
```typescript
const DEFAULT_COMMAND = "npx -y @modelcontextprotocol/server-filesystem .";
```
