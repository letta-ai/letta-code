import { Box, Text } from "ink";
import type { SessionStatsSnapshot } from "../../agent/stats";

interface SessionStatsProps {
  stats: SessionStatsSnapshot;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function SessionStats({ stats }: SessionStatsProps) {
  const wallDuration = formatDuration(stats.totalWallMs);
  const apiDuration = formatDuration(stats.totalApiMs);

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text dimColor>Total duration (API): {apiDuration}</Text>
      <Text dimColor>Total duration (wall): {wallDuration}</Text>
      <Text dimColor>
        Usage: {stats.usage.stepCount} steps,{" "}
        {formatNumber(stats.usage.promptTokens)} input,{" "}
        {formatNumber(stats.usage.completionTokens)} output
      </Text>
    </Box>
  );
}
