import { Box, Text } from "ink";
import Link from "ink-link";
import { useMemo } from "react";
import { DEFAULT_AGENT_NAME } from "../../constants";
import { settingsManager } from "../../settings-manager";
import { colors } from "./colors";

interface AgentInfoBarProps {
  agentId?: string;
  agentName?: string | null;
  serverUrl?: string;
}

/**
 * Shows agent info bar with current agent details and useful links
 */
export function AgentInfoBar({
  agentId,
  agentName,
  serverUrl,
}: AgentInfoBarProps) {
  // Check if current agent is pinned
  const isPinned = useMemo(() => {
    if (!agentId) return false;
    const localPinned = settingsManager.getLocalPinnedAgents();
    const globalPinned = settingsManager.getGlobalPinnedAgents();
    return localPinned.includes(agentId) || globalPinned.includes(agentId);
  }, [agentId]);

  const isCloudUser = serverUrl?.includes("api.letta.com");
  const showBottomBar = agentId && agentId !== "loading";

  if (!showBottomBar) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.command.border}
      paddingX={1}
    >
      <Box>
        <Text bold>{agentName || "Unnamed"}</Text>
        {isPinned ? (
          <Text color="green"> (pinned ✓)</Text>
        ) : agentName === DEFAULT_AGENT_NAME || !agentName ? (
          <Text color="gray"> (type /pin to give your agent a real name!)</Text>
        ) : (
          <Text color="gray"> (type /pin to pin agent)</Text>
        )}
      </Box>
      <Box>
        <Text dimColor>{agentId}</Text>
        {isCloudUser && (
          <>
            <Text dimColor> · </Text>
            <Link url={`https://app.letta.com/agents/${agentId}`}>
              <Text color={colors.link.text}>Open in ADE ↗</Text>
            </Link>
            <Text dimColor> · </Text>
            <Link url="https://app.letta.com/settings/organization/usage">
              <Text color={colors.link.text}>View usage ↗</Text>
            </Link>
          </>
        )}
        {!isCloudUser && <Text dimColor> · {serverUrl}</Text>}
      </Box>
    </Box>
  );
}
