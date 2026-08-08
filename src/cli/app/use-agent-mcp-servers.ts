import { useEffect } from "react";
import { closeClientMcpServers, replaceClientMcpServers } from "@/mcp-runtime";

export { closeClientMcpServers as closeMcp } from "@/mcp-runtime";

import { settingsManager } from "@/settings-manager";
import { debugWarn } from "@/utils/debug";

export function useAgentMcpServers(agentId: string | undefined): void {
  useEffect(() => {
    const refresh = agentId
      ? replaceClientMcpServers(agentId, settingsManager.getMcpServers(agentId))
      : closeClientMcpServers();
    void refresh.catch((error) =>
      debugWarn("mcp", `Failed to switch agent MCP servers: ${String(error)}`),
    );
  }, [agentId]);
}
