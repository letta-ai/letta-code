import { Box } from "ink";
import { memo } from "react";
import { Text } from "./Text";

type TrajectorySummaryLine = {
  kind: "trajectory_summary";
  id: string;
  durationMs: number;
  stepCount: number;
  verb: string;
};

export const TrajectorySummary = memo(
  ({ line }: { line: TrajectorySummaryLine }) => {
    const duration = formatSummaryDuration(line.durationMs);
    const verb =
      line.verb.length > 0
        ? line.verb.charAt(0).toUpperCase() + line.verb.slice(1)
        : line.verb;
    const summary = `${verb} for ${duration}`;

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text dimColor>✻</Text>
        </Box>
        <Box flexGrow={1}>
          <Text dimColor>{summary}</Text>
        </Box>
      </Box>
    );
  },
);

TrajectorySummary.displayName = "TrajectorySummary";

function formatSummaryDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${Math.max(0, totalSeconds)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [`${hours}hr`];
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}
