import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  callCloudTool,
  getCloudToolsClient,
  listCloudTools,
} from "@/backend/api/cloud-tools";
import type { UnifiedMcpClient } from "@/backend/api/unified-mcp";
import { settingsManager } from "@/settings-manager";

/** A protocol relay: names, instructions, schemas and execution are owned by the API. */
export async function serveCloudTools(
  client: UnifiedMcpClient,
  transport: Transport,
): Promise<Server> {
  const catalog = await listCloudTools(client);
  const server = new Server(
    { name: catalog.serverName, version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: catalog.instructions,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.tools,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callCloudTool(client, request.params.name, request.params.arguments ?? {}),
  );
  await server.connect(transport);
  return server;
}

export async function runMcpServeSubcommand(): Promise<number> {
  await settingsManager.initialize();
  await serveCloudTools(
    await getCloudToolsClient(),
    new StdioServerTransport(),
  );
  return 0;
}
