import type { McpServerConfig } from "@/mcp-client";
import { settingsManager } from "@/settings-manager";
import { discoverCloudToolsConfig } from "@/tools/impl/cloud-tools-config";

export async function getLocalServers(
  deps: {
    getLocalServers?: (id: string) => McpServerConfig[];
    env?: NodeJS.ProcessEnv;
  },
  agentId: string,
): Promise<McpServerConfig[]> {
  if (deps.getLocalServers) return deps.getLocalServers(agentId);
  const servers = settingsManager.getMcpServers(agentId);
  const cloud = await discoverCloudToolsConfig(deps.env ?? process.env);
  return cloud
    ? [...servers.filter((s) => s.name !== cloud.name), cloud]
    : servers;
}
