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

function renderPanelLines(panel: ModPanel, width: number): string[] {
  let result: string | string[];
  try {
    result = panel.render({ width });
  } catch {
    // A mod's render fn runs inside the input render; never let it crash the UI.
    return [];
  }
  const lines = Array.isArray(result) ? result : String(result).split("\n");
  return lines.map(String);
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
    .flatMap((panel) => renderPanelLines(panel, rowWidth))
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
