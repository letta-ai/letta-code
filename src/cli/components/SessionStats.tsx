import { Box, Text } from "ink";
import type { SessionStatsSnapshot } from "../../agent/stats";

interface SessionStatsProps {
  stats: SessionStatsSnapshot;
  agentId?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function SessionStats({ stats, agentId }: SessionStatsProps) {
  const wallDuration = formatDuration(stats.totalWallMs);
  const apiDuration = formatDuration(stats.totalApiMs);

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text dimColor>Total duration (API): {apiDuration}</Text>
      <Text dimColor>Total duration (wall): {wallDuration}</Text>
      <Text dimColor>
        Usage: {stats.usage.stepCount} steps · {formatNumber(stats.usage.promptTokens)} input ·{" "}
        {formatNumber(stats.usage.completionTokens)} output
      </Text>
      {agentId && <Text dimColor>Agent ID: {agentId}</Text>}
    </Box>
  );
}
