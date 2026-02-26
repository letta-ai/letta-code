import { Box } from "ink";
import Link from "ink-link";
import { memo, useMemo } from "react";
import stringWidth from "string-width";
import type { ModelReasoningEffort } from "../../agent/model";
import { DEFAULT_AGENT_NAME } from "../../constants";
import { settingsManager } from "../../settings-manager";
import { getVersion } from "../../version";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);

  const suffix = "...";
  const budget = Math.max(0, maxWidth - stringWidth(suffix));
  let out = "";
  for (const ch of text) {
    const next = out + ch;
    if (stringWidth(next) > budget) break;
    out = next;
  }
  return out + suffix;
}

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
  if (effort === "none") return null;
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
  const columns = useTerminalWidth();
  const isTmux = Boolean(process.env.TMUX);
  // Check if current agent is pinned
  const isPinned = useMemo(() => {
    if (!agentId) return false;
    const localPinned = settingsManager.getLocalPinnedAgents();
    const globalPinned = settingsManager.getGlobalPinnedAgents();
    return localPinned.includes(agentId) || globalPinned.includes(agentId);
  }, [agentId]);

  const isCloudUser = serverUrl?.includes("api.letta.com");
  const adeConversationUrl =
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
  const leftWidth = Math.max(...alienLines.map((l) => stringWidth(l)));
  const rightWidth = Math.max(0, columns - leftWidth);

  const agentNameLabel = agentName || "Unnamed";
  const agentHint = isPinned
    ? " (pinned)"
    : agentName === DEFAULT_AGENT_NAME || !agentName
      ? " (type /pin to give your agent a real name!)"
      : " (type /pin to pin agent)";
  const agentNameLine = `${agentNameLabel}${agentHint}`;

  return (
    <Box flexDirection="column">
      {/* Blank line after commands */}
      <Box height={1} />

      {/* Version and Discord/feedback info */}
      <Box>
        <Text wrap="truncate-end">
          {"  "}Letta Code v{getVersion()} · /feedback · discord.gg/letta
        </Text>
      </Box>

      {/* Blank line before agent info */}
      <Box height={1} />

      {/* Alien + Agent name */}
      <Box>
        <Text color={colors.footer.agentName}>{alienLines[0]}</Text>
        <Box width={rightWidth} flexShrink={1}>
          <Text bold color={colors.footer.agentName} wrap="truncate-end">
            {truncateText(agentNameLine, rightWidth)}
          </Text>
        </Box>
      </Box>

      {/* Alien + Links */}
      <Box>
        <Text color={colors.footer.agentName}>{alienLines[1]}</Text>
        {isCloudUser && adeConversationUrl && !isTmux && (
          <Box flexShrink={1}>
            <Link url={adeConversationUrl}>
              <Text>Open in ADE ↗</Text>
            </Link>
            <Text dimColor>· </Text>
            <Link url="https://app.letta.com/settings/organization/usage">
              <Text>View usage ↗</Text>
            </Link>
          </Box>
        )}
        {isCloudUser && adeConversationUrl && isTmux && (
          <Box width={rightWidth} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {truncateText(
                `Open in ADE: ${adeConversationUrl} · Usage: https://app.letta.com/settings/organization/usage`,
                rightWidth,
              )}
            </Text>
          </Box>
        )}
        {!isCloudUser && (
          <Box width={rightWidth} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {truncateText(serverUrl ?? "", rightWidth)}
            </Text>
          </Box>
        )}
      </Box>

      {/* Model summary */}
      <Box>
        <Text color={colors.footer.agentName}>{alienLines[2]}</Text>
        <Box width={rightWidth} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {truncateText(modelLine ?? "model unknown", rightWidth)}
          </Text>
        </Box>
      </Box>

      {/* Agent ID */}
      <Box>
        <Text>{alienLines[3]}</Text>
        <Box width={rightWidth} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {truncateText(agentId, rightWidth)}
          </Text>
        </Box>
      </Box>

      {/* Phantom alien row + Conversation ID */}
      <Box>
        <Text>{alienLines[3]}</Text>
        {conversationId && conversationId !== "default" ? (
          <Box width={rightWidth} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {truncateText(conversationId, rightWidth)}
            </Text>
          </Box>
        ) : (
          <Box width={rightWidth} flexShrink={1}>
            <Text dimColor>default conversation</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
});
