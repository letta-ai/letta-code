# MCP (Model Context Protocol) Stdio Support

This module enables client-side execution of stdio MCP servers in Letta Code.

## Overview

MCP servers can run in three transport modes:

1. **HTTP/Streamable HTTP** - Server runs remotely, tools execute server-side ✅ Already supported
2. **SSE (Server-Sent Events)** - Server runs remotely, tools execute server-side ✅ Already supported
3. **Stdio** - Server runs locally via subprocess, tools execute client-side ✅ **NEW**

Since Letta agents run on the server, stdio MCP servers cannot be executed server-side. This module solves that by:

1. Running stdio MCP servers as client-side subprocesses
2. Intercepting tool calls for stdio servers
3. Executing them locally via the MCP SDK
4. Returning results to the Letta server

## Architecture

```
┌─────────────────────────────────────────┐
│         Letta Code CLI (Client)         │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │   stdio-client.ts               │   │
│  │   - Manages stdio subprocesses  │   │
│  │   - MCP SDK client connections  │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │   tracker.ts                    │   │
│  │   - Maps tools → servers        │   │
│  │   - Identifies stdio tools      │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │   executor.ts                   │   │
│  │   - Intercepts tool calls       │   │
│  │   - Routes stdio tools locally  │   │
│  └─────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘
              │
              │ API calls (non-stdio tools)
              ↓
┌─────────────────────────────────────────┐
│         Letta Server (Backend)          │
│                                         │
│  - Manages agents & conversations       │
│  - Executes HTTP/SSE MCP tools         │
│  - Stores results                       │
└─────────────────────────────────────────┘
```

## Usage

### Adding a Stdio MCP Server

```bash
# Interactive mode
letta
/mcp add --transport stdio npx-mcp npx @modelcontextprotocol/server-everything

# Or use the connect wizard (with OAuth support)
/mcp connect
```

### Example: Filesystem MCP Server

```bash
# Add the official filesystem MCP server
/mcp add --transport stdio filesystem npx @modelcontextprotocol/server-filesystem /path/to/directory

# The server will run as: npx @modelcontextprotocol/server-filesystem /path/to/directory
# Tools are automatically discovered and synced
```

### How It Works

1. **Server Registration**: Stdio servers are registered with the Letta backend (same as HTTP/SSE)
2. **Client-Side Sync**: On agent initialization, `mcpToolTracker.sync()` fetches all MCP servers and tools
3. **Subprocess Spawning**: For stdio servers, `stdioClientManager` spawns the subprocess and establishes MCP connection
4. **Tool Call Interception**: When a tool is called, `executeStdioMcpTool()` checks if it's a stdio tool
5. **Local Execution**: If stdio, the tool is executed client-side via MCP SDK
6. **Result Return**: Result is formatted and returned as if it came from the server

## API Reference

### `stdioClientManager`

Manages stdio MCP server connections.

```typescript
import { stdioClientManager } from "./mcp";

// Connect to a server
await stdioClientManager.connect({
  serverId: "server-123",
  serverName: "my-server",
  command: "npx",
  args: ["@modelcontextprotocol/server-filesystem", "/path"],
});

// Execute a tool
const result = await stdioClientManager.executeTool(
  "server-123",
  "read_file",
  { path: "example.txt" },
);

// Disconnect
await stdioClientManager.disconnect("server-123");
```

### `mcpToolTracker`

Tracks tool-to-server mappings.

```typescript
import { mcpToolTracker } from "./mcp";

// Sync tools from backend
await mcpToolTracker.sync(agentId);

// Check if a tool is from a stdio server
if (mcpToolTracker.isStdioTool("read_file")) {
  // Execute client-side
}

// Get server ID for a tool
const serverId = mcpToolTracker.getToolServerId("read_file");
```

### `executeStdioMcpTool`

Intercepts and executes stdio MCP tools.

```typescript
import { executeStdioMcpTool } from "./mcp";

// Returns null if not a stdio tool
const result = await executeStdioMcpTool("read_file", {
  path: "example.txt",
});

if (result !== null) {
  // Was a stdio tool, executed client-side
  console.log(result.toolReturn);
}
```

## Error Handling

Stdio MCP execution includes robust error handling:

- **Connection Failures**: Logged to stderr, execution fails gracefully
- **Tool Execution Errors**: Returned as error status with message
- **Process Crashes**: Detected and logged, connection marked as failed
- **Cleanup**: All subprocesses cleaned up on exit

## Limitations

1. **Client-Side Only**: Stdio servers only work in CLI/desktop mode, not in web-based UIs
2. **No OAuth**: Stdio servers don't support OAuth (they run locally)
3. **Process Management**: Long-running servers are subprocess children of the CLI

## Future Enhancements

- [ ] Auto-restart crashed stdio servers
- [ ] Health checks for stdio connections
- [ ] Stdio server output logging/debugging
- [ ] Support for stdio server environment variables
- [ ] Shared stdio connections across agents

## Related Files

- `src/mcp/stdio-client.ts` - Stdio subprocess manager
- `src/mcp/tracker.ts` - Tool-to-server mapping tracker
- `src/mcp/executor.ts` - Client-side execution logic
- `src/tools/manager.ts` - Modified to intercept stdio tools
- `src/headless.ts` - Sync and cleanup integration
