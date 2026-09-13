import stringWidth from "string-width";
import { BRAILLE_SPINNER_FRAMES } from "@/cli/components/BlinkingSpinner";
import { colors } from "@/cli/components/colors";
import type { ModPanel } from "@/cli/mods/types";
import { DEFAULT_PRODUCT_STATUS_ORDER } from "./order";

const ACTIVE_BACKGROUND_AGENT_STATUSES = new Set<string>([
  "pending",
  "running",
]);

export { DEFAULT_PRODUCT_STATUS_ORDER } from "./order";
export const PRODUCT_STATUS_SPINNER_INTERVAL_MS = 90;
export const PRODUCT_STATUS_SPINNER_PULSE_INTERVAL_MS = 400;

export interface DefaultProductStatusPanelOptions {
  spinnerDimmed?: boolean;
  spinnerFrame?: string;
  agentUrl?: string | null;
}

function paddedSpinnerFrame(frame: string, width: number): string {
  const frameWidth = stringWidth(frame);
  const targetWidth = Math.max(1, width);
  const totalPadding = Math.max(0, targetWidth - frameWidth);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return " ".repeat(leftPadding) + frame + " ".repeat(rightPadding);
}

function typeLabelForBackgroundAgent(type: string): string {
  const rawType = type.toLowerCase();
  return rawType === "reflection" ? "dreaming" : rawType;
}

export function createDefaultProductStatusPanel(
  options: DefaultProductStatusPanelOptions = {},
): ModPanel {
  return {
    id: "default:dreaming",
    order: DEFAULT_PRODUCT_STATUS_ORDER,
    path: "default:dreaming",
    updatedAt: 0,
    render(ctx) {
      const backgroundAgent = ctx.backgroundAgents.find((agent) =>
        ACTIVE_BACKGROUND_AGENT_STATUSES.has(agent.status),
      );

      if (!backgroundAgent) return "";

      const elapsedSeconds = Math.round(backgroundAgent.durationMs / 1000);
      const spinnerText = paddedSpinnerFrame(
        options.spinnerFrame ?? BRAILLE_SPINNER_FRAMES[0],
        2,
      );
      const spinnerStyle = ctx.chalk.hex(colors.bgSubagent.spinner);
      const spinner = options.spinnerDimmed
        ? spinnerStyle.dim(spinnerText)
        : spinnerStyle(spinnerText);
      const label = ctx.chalk.hex(colors.bgSubagent.label)(
        typeLabelForBackgroundAgent(backgroundAgent.type),
      );
      const elapsed = ctx.chalk.dim(` (${elapsedSeconds}s)`);
      const isTmux = Boolean(process.env.TMUX);
      const linkedLabel =
        options.agentUrl && !isTmux ? ctx.link(label, options.agentUrl) : label;

      return ctx.row("", `${spinner}${linkedLabel}${elapsed}`, ctx.width);
    },
  };
}

export const defaultProductStatusPanel = createDefaultProductStatusPanel();

export function withDefaultProductStatusPanel(
  panels: Record<string, ModPanel> | undefined,
  options: DefaultProductStatusPanelOptions = {},
): Record<string, ModPanel> {
  const existingPanels = panels ?? {};
  const hasUserProductStatusPanel = Object.values(existingPanels).some(
    (panel) => panel.order === DEFAULT_PRODUCT_STATUS_ORDER,
  );
  if (hasUserProductStatusPanel) {
    return existingPanels;
  }

  const defaultPanel = createDefaultProductStatusPanel(options);
  return {
    ...existingPanels,
    [defaultPanel.id]: defaultPanel,
  };
}
