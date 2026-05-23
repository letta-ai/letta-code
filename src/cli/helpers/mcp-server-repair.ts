import type {
  SseMcpServer,
  StdioMcpServer,
  StreamableHTTPMcpServer,
  UpdateSseMcpServer,
  UpdateStreamableHTTPMcpServer,
} from "@letta-ai/letta-client/resources/mcp-servers/mcp-servers";

type RepairableMcpServer = SseMcpServer | StreamableHTTPMcpServer;
type McpServer = RepairableMcpServer | StdioMcpServer;

type RepairConfig = UpdateSseMcpServer | UpdateStreamableHTTPMcpServer;

interface McpServerRepair {
  server_name: string;
  config: RepairConfig;
}

function hasCustomHeaders(server: RepairableMcpServer): boolean {
  return (
    !!server.custom_headers && Object.keys(server.custom_headers).length > 0
  );
}

function hasVisibleAuth(server: RepairableMcpServer): boolean {
  return (
    !!server.auth_header || !!server.auth_token || hasCustomHeaders(server)
  );
}

export function buildLegacyMcpServerRepair(
  server: McpServer,
): McpServerRepair | null {
  if (server.mcp_server_type === "sse") {
    if (!server.server_url.trim() || hasVisibleAuth(server)) {
      return null;
    }

    return {
      server_name: server.server_name,
      config: {
        mcp_server_type: "sse",
        server_url: server.server_url,
      },
    };
  }

  if (server.mcp_server_type === "streamable_http") {
    if (!server.server_url.trim() || hasVisibleAuth(server)) {
      return null;
    }

    return {
      server_name: server.server_name,
      config: {
        mcp_server_type: "streamable_http",
        server_url: server.server_url,
      },
    };
  }

  return null;
}
