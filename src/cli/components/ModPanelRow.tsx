import { Box } from "ink";
import { truncateText } from "@/cli/helpers/truncate-text";
import type { ModPanel } from "@/cli/mods/types";
import { Text } from "./Text";

const MAX_MOD_PANEL_LINES = 8;

function visiblePanels(panels: Record<string, ModPanel>): ModPanel[] {
  return Object.values(panels).sort(
    (a, b) => a.order - b.order || b.updatedAt - a.updatedAt,
  );
}

export function ModPanelRow({
  panels,
  terminalWidth,
}: {
  panels?: Record<string, ModPanel>;
  terminalWidth: number;
}) {
  const rowWidth = Math.max(0, terminalWidth - 1);
  if (rowWidth === 0) return null;

  const lines = visiblePanels(panels ?? {})
    .flatMap((panel) => panel.content)
    .slice(0, MAX_MOD_PANEL_LINES);
  if (lines.length === 0) return null;

  return (
    <Box width={rowWidth} flexDirection="column">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: panel content is caller-owned text
        <Text key={index}>{truncateText(line || " ", rowWidth)}</Text>
      ))}
    </Box>
  );
}
