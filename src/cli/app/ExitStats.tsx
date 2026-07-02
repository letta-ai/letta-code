import { Box } from "ink";
import type { SessionStatsSnapshot } from "@/agent/stats";
import { colors } from "@/cli/components/colors";
import { formatDuration } from "@/cli/components/SessionStats";
import { Text } from "@/cli/components/Text";
import { formatCompact } from "@/cli/helpers/format";
import { settingsManager } from "@/settings-manager";

export function ExitStats({
  stats,
  agentName,
  agentId,
  conversationId,
}: {
  stats: SessionStatsSnapshot;
  agentName: string | null;
  agentId: string;
  conversationId: string;
}) {
  const isPinned = agentName && settingsManager.isAgentPinned(agentId);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Alien + Stats (3 lines) */}
      <Box>
        <Text color={colors.footer.agentName}>{" ▗▖▗▖   "}</Text>
        <Text dimColor>
          Total duration (API): {formatDuration(stats.totalApiMs)}
        </Text>
      </Box>
      <Box>
        <Text color={colors.footer.agentName}>{"▙█▜▛█▟  "}</Text>
        <Text dimColor>
          Total duration (wall): {formatDuration(stats.totalWallMs)}
        </Text>
      </Box>
      <Box>
        <Text color={colors.footer.agentName}>{"▝▜▛▜▛▘  "}</Text>
        <Text dimColor>
          Session usage: {stats.usage.stepCount} steps,{" "}
          {formatCompact(stats.usage.promptTokens)} input,{" "}
          {formatCompact(stats.usage.completionTokens)} output
        </Text>
      </Box>
      {/* Resume commands (no alien) */}
      <Box height={1} />
      <Text dimColor>Resume this agent with:</Text>
      <Text color={colors.link.url}>
        {isPinned ? `letta -n "${agentName}"` : `letta --agent ${agentId}`}
      </Text>
      {/* Only show conversation hint if not on default (default is resumed automatically) */}
      {conversationId !== "default" && conversationId !== agentId && (
        <>
          <Box height={1} />
          <Text dimColor>Resume this conversation with:</Text>
          <Text
            color={colors.link.url}
          >{`letta --conv ${conversationId}`}</Text>
        </>
      )}
    </Box>
  );
}
