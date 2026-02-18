import { Box } from "ink";
import Link from "ink-link";
import { memo, useMemo } from "react";
import type { ModelReasoningEffort } from "../../agent/model";
import { DEFAULT_AGENT_NAME } from "../../constants";
import { settingsManager } from "../../settings-manager";
import { getVersion } from "../../version";
import { colors } from "./colors";
import { Text } from "./Text";

interface AgentInfoBarProps {
  agentId?: string;
  agentName?: string | null;
  currentModel?: string | null;
  currentReasoningEffort?: ModelReasoningEffort | null;
  serverUrl?: string;
  conversationId?: string;
}

function formatReasoningLabel(
  effort: ModelReasoningEffort | null | undefined,
): string | null {
  if (effort === "none") return "no";
  if (effort === "xhigh") return "max";
  if (effort === "minimal") return "minimal";
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high") return "high";
  return null;
}

/**
 * Shows agent info bar with current agent details and useful links.
 */
export const AgentInfoBar = memo(function AgentInfoBar({
  agentId,
  agentName,
  currentModel,
  currentReasoningEffort,
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
  const reasoningLabel = formatReasoningLabel(currentReasoningEffort);
  const modelLine = currentModel
    ? `${currentModel}${reasoningLabel ? ` (${reasoningLabel})` : ""}`
    : null;

  if (!showBottomBar) {
    return null;
  }

  // Alien ASCII art lines (4 lines tall, with 2-char indent + extra space before text)
  const alienLines = ["   ▗▖▗▖   ", "  ▙█▜▛█▟  ", "  ▝▜▛▜▛▘  ", "          "];

  return (
    <Box flexDirection="column">
      {/* Blank line after commands */}
      <Box height={1} />

      {/* Version and Discord/feedback info */}
      <Box>
        <Text>
          {"  "}Letta Code v{getVersion()} · Report bugs with /feedback or{" "}
          <Link url="https://discord.gg/letta">
            <Text>on Discord ↗</Text>
          </Link>
        </Text>
      </Box>

      {/* Blank line before agent info */}
      <Box height={1} />

      {/* Alien + Agent name */}
      <Box>
        <Text color={colors.footer.agentName}>{alienLines[0]}</Text>
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
      </Box>

      {/* Alien + Links */}
      <Box>
        <Text color={colors.footer.agentName}>{alienLines[1]}</Text>
        {isCloudUser && adeUrl && !isTmux && (
          <>
            <Link url={adeUrl}>
              <Text>Open in ADE ↗</Text>
            </Link>
            <Text dimColor>· </Text>
          </>
        )}
        {isCloudUser && adeUrl && isTmux && (
          <Text dimColor>Open in ADE: {adeUrl} · </Text>
        )}
        {isCloudUser && (
          <Link url="https://app.letta.com/settings/organization/usage">
            <Text>View usage ↗</Text>
          </Link>
        )}
        {!isCloudUser && <Text dimColor>{serverUrl}</Text>}
      </Box>

      {/* Model summary */}
      <Box>
        <Text color={colors.footer.agentName}>{alienLines[2]}</Text>
        <Text dimColor>{modelLine ?? "model unknown"}</Text>
      </Box>

      {/* Agent ID */}
      <Box>
        <Text>{alienLines[3]}</Text>
        <Text dimColor>{agentId}</Text>
      </Box>

      {/* Phantom alien row + Conversation ID */}
      <Box>
        <Text>{alienLines[3]}</Text>
        {conversationId && conversationId !== "default" ? (
          <Text dimColor>{conversationId}</Text>
        ) : (
          <Text dimColor>default conversation</Text>
        )}
      </Box>
    </Box>
  );
});
