import { useEffect, useRef } from "react";
import { closeClientMcpServers } from "@/mcp-runtime";

export { closeClientMcpServers as closeMcp } from "@/mcp-runtime";

import { debugWarn } from "@/utils/debug";

export function useMcpCleanup(agentId: string | undefined): void {
  const previousAgentId = useRef(agentId);
  useEffect(() => {
    if (previousAgentId.current === agentId) return;
    previousAgentId.current = agentId;
    void closeClientMcpServers().catch((error) =>
      debugWarn("mcp", `Failed to close client MCP servers: ${String(error)}`),
    );
  }, [agentId]);
}
