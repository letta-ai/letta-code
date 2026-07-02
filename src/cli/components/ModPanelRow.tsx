import chalk from "chalk";
import { Box } from "ink";
import {
  columns,
  row,
  truncateToWidth,
} from "@/cli/display/statusline/formatting";
import type {
  ModContext,
  ModPanel,
  ModPanelRenderContext,
} from "@/cli/mods/types";
import { Text } from "./Text";

const MAX_MOD_PANEL_LINES = 8;

export type ModPanelPlacement = "above" | "below";

function placedPanels(
  panels: Record<string, ModPanel>,
  placement: ModPanelPlacement,
): ModPanel[] {
  return Object.values(panels)
    .filter((panel) =>
      placement === "above" ? panel.order > 0 : panel.order < 0,
    )
    .sort((a, b) => b.order - a.order || b.updatedAt - a.updatedAt);
}

export function renderModPanelLines(
  panel: ModPanel,
  width: number,
  context: ModContext,
): string[] {
  let result: string | string[];
  try {
    const renderContext: ModPanelRenderContext = {
      ...context,
      width,
      row,
      columns,
      chalk,
    };
    result = panel.render(renderContext);
  } catch {
    // A mod's render fn runs inside the input render; never let it crash the UI.
    return [];
  }
  const lines = Array.isArray(result) ? result : String(result).split("\n");
  // An empty render hides the panel entirely (no blank row).
  if (lines.every((line) => line.trim().length === 0)) return [];
  return lines.map(String);
}

export function ModPanelRow({
  panels,
  terminalWidth,
  placement,
  context,
}: {
  panels?: Record<string, ModPanel>;
  terminalWidth: number;
  placement: ModPanelPlacement;
  context: ModContext;
}) {
  const rowWidth = Math.max(0, terminalWidth - 1);
  if (rowWidth === 0) return null;

  const lines = placedPanels(panels ?? {}, placement)
    .flatMap((panel) => renderModPanelLines(panel, rowWidth, context))
    .slice(0, MAX_MOD_PANEL_LINES);
  if (lines.length === 0) return null;

  return (
    <Box width={rowWidth} flexDirection="column">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: panel content is caller-owned text
        <Text key={index}>{truncateToWidth(line || " ", rowWidth)}</Text>
      ))}
    </Box>
  );
}
