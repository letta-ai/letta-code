import { Box, Text } from "ink";
import Link from "ink-link";
import { memo, useMemo } from "react";
import { DEFAULT_AGENT_NAME } from "../../constants";
import { settingsManager } from "../../settings-manager";
import { getVersion } from "../../version";
import { colors } from "./colors";

interface AgentInfoBarProps {
  agentId?: string;
  agentName?: string | null;
  serverUrl?: string;
  conversationId?: string;
}

/**
 * Shows agent info bar with current agent details and useful links.
 */
export const AgentInfoBar = memo(function AgentInfoBar({
  agentId,
  agentName,
  serverUrl,
  conversationId,
}: AgentInfoBarProps) {
  const isTmux = Boolean(process.env.TMUX);
  // Check if current agent is pinned
  const isPinned = useMemo(() => {
    if (!agentId) return false;
    const localPinned = settingsManager.getLocalPinnedAgents();
    const globalPinned = settingsManager.getGlobalPinnedAgents();
    return localPinned.includes(agentId) || globalPinned.includes(agentId);
  }, [agentId]);

  const isCloudUser = serverUrl?.includes("api.letta.com");
  const adeUrl =
    agentId && agentId !== "loading"
      ? `https://app.letta.com/agents/${agentId}${conversationId && conversationId !== "default" ? `?conversation=${conversationId}` : ""}`
      : "";
  const showBottomBar = agentId && agentId !== "loading";

  if (!showBottomBar) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {/* Blank line after commands */}
      <Box height={1} />

      {/* Discord/version info */}
      <Box>
        <Text>
          {"  "}Having issues? Report bugs with /feedback or{" "}
          <Link url="https://discord.gg/letta">
            <Text>join our Discord ↗</Text>
          </Link>
        </Text>
      </Box>
      <Box>
        <Text>
          {"  "}Version: Letta Code v{getVersion()}
        </Text>
      </Box>

      {/* Blank line before agent info */}
      <Box height={1} />

      {/* Agent name and links */}
      <Box>
        <Text>{"  "}</Text>
        <Text bold color={colors.footer.agentName}>
          {agentName || "Unnamed"}
        </Text>
        {isPinned ? (
          <Text color="green"> (pinned ✓)</Text>
        ) : agentName === DEFAULT_AGENT_NAME || !agentName ? (
          <Text color="gray"> (type /pin to give your agent a real name!)</Text>
        ) : (
          <Text color="gray"> (type /pin to pin agent)</Text>
        )}
        <Text dimColor> · {agentId}</Text>
      </Box>
      <Box>
        <Text dimColor>{"  "}</Text>
        {isCloudUser && adeUrl && !isTmux && (
          <Link url={adeUrl}>
            <Text>Open in ADE ↗</Text>
          </Link>
        )}
        {isCloudUser && adeUrl && isTmux && <Text>Open in ADE: {adeUrl}</Text>}
        {isCloudUser && <Text dimColor>{" · "}</Text>}
        {isCloudUser && (
          <Link url="https://app.letta.com/settings/organization/usage">
            <Text>View usage ↗</Text>
          </Link>
        )}
        {!isCloudUser && <Text dimColor>{serverUrl}</Text>}
      </Box>
    </Box>
  );
});
