import { getCurrentAgentId } from "@/agent/context";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import {
  listAgentConnectedMcpServers,
  listAgentConnectedMcpTools,
  runAgentConnectedMcpTool,
} from "@/backend/api/mcp-servers";
import { validateRequiredParams } from "./validation";

type AgentMcpCommand = "list_servers" | "list_tools" | "run_tool";

interface AgentMcpArgs {
  command: AgentMcpCommand;
  mcp_server_id?: string;
  tool_id?: string;
  args?: Record<string, unknown>;
}

interface AgentMcpListServersResult {
  agent_id: string;
  servers: Awaited<ReturnType<typeof listAgentConnectedMcpServers>>;
}

interface AgentMcpListToolsResult {
  agent_id: string;
  mcp_server_id: string;
  tools: Awaited<ReturnType<typeof listAgentConnectedMcpTools>>;
}

interface AgentMcpRunToolResult {
  agent_id: string;
  mcp_server_id: string;
  tool_id: string;
  result: Awaited<ReturnType<typeof runAgentConnectedMcpTool>>;
}

type AgentMcpResult =
  | AgentMcpListServersResult
  | AgentMcpListToolsResult
  | AgentMcpRunToolResult;

function requireServerId(args: AgentMcpArgs): string {
  validateRequiredParams(args, ["mcp_server_id"], "agent_mcp");
  const serverId = args.mcp_server_id?.trim();
  if (!serverId) {
    throw new Error("agent_mcp: mcp_server_id must be a non-empty string");
  }
  return serverId;
}

function requireToolId(args: AgentMcpArgs): string {
  validateRequiredParams(args, ["tool_id"], "agent_mcp");
  const toolId = args.tool_id?.trim();
  if (!toolId) {
    throw new Error("agent_mcp: tool_id must be a non-empty string");
  }
  return toolId;
}

function assertServerSideMcpAvailable(): void {
  if (!getBackend().capabilities.serverSideToolManagement) {
    throw new Error(
      "agent_mcp is available only for signed-in Letta Cloud agents.",
    );
  }
}

export async function agent_mcp(args: AgentMcpArgs): Promise<AgentMcpResult> {
  validateRequiredParams(args, ["command"], "agent_mcp");
  assertServerSideMcpAvailable();

  const agentId = getCurrentAgentId();
  const client = await getClient();

  if (args.command === "list_servers") {
    return {
      agent_id: agentId,
      servers: await listAgentConnectedMcpServers(client, agentId),
    };
  }

  if (args.command === "list_tools") {
    const serverId = requireServerId(args);
    return {
      agent_id: agentId,
      mcp_server_id: serverId,
      tools: await listAgentConnectedMcpTools(client, agentId, serverId),
    };
  }

  if (args.command === "run_tool") {
    const serverId = requireServerId(args);
    const toolId = requireToolId(args);
    return {
      agent_id: agentId,
      mcp_server_id: serverId,
      tool_id: toolId,
      result: await runAgentConnectedMcpTool({
        client,
        agentId,
        mcpServerId: serverId,
        toolId,
        args: args.args ?? {},
      }),
    };
  }

  throw new Error(`agent_mcp: unknown command ${args.command}`);
}
