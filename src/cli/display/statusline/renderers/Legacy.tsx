import chalk from "chalk";
import { colors } from "@/cli/components/colors";
import {
  formatStatuslineReasoningEffort,
  truncateStatuslineText,
} from "@/cli/display/statusline/formatting";
import { CommandHintSegment } from "@/cli/display/statusline/Segments";
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
  StatuslineRendererOutput,
} from "@/cli/display/statusline/types";
import { shouldHideReasoningForModelDisplay } from "@/cli/helpers/startup-model-display";

export function renderLegacyStatusline(
  context: StatuslineRenderContext,
): StatuslineRendererOutput {
  const maxAgentChars = Math.max(
    10,
    Math.floor(context.rightColumnWidth * 0.45),
  );
  const displayAgentName = truncateStatuslineText(
    context.agentName || "Unnamed",
    maxAgentChars,
  );
  const reasoningTag = shouldHideReasoningForModelDisplay(context.currentModel)
    ? null
    : formatStatuslineReasoningEffort(context.currentReasoningEffort);
  const byokExtraChars = context.isByokProvider ? 2 : 0;
  const tempOverrideExtraChars = context.hasTemporaryModelOverride ? 2 : 0;

  const baseReservedChars =
    displayAgentName.length + byokExtraChars + tempOverrideExtraChars + 4;
  const modelWithReasoning =
    (context.currentModel ?? "unknown") +
    (reasoningTag ? ` (${reasoningTag})` : "");

  const maxModelChars = Math.max(
    8,
    context.rightColumnWidth - baseReservedChars,
  );
  const displayModel = truncateStatuslineText(
    modelWithReasoning,
    maxModelChars,
  );
  const rightWidth =
    displayAgentName.length +
    displayModel.length +
    byokExtraChars +
    tempOverrideExtraChars +
    3;
  const rightPrefixSpaces = Math.max(0, context.rightColumnWidth - rightWidth);

  const rightCoreParts: string[] = [];
  rightCoreParts.push(chalk.hex(colors.footer.agentName)(displayAgentName));
  rightCoreParts.push(chalk.dim(" ["));
  rightCoreParts.push(chalk.dim(displayModel));
  if (context.isByokProvider) {
    rightCoreParts.push(chalk.dim(" "));
    rightCoreParts.push(
      context.isOpenAICodexProvider
        ? chalk.hex("#74AA9C")("▲")
        : chalk.yellow("▲"),
    );
  }
  if (context.hasTemporaryModelOverride) {
    rightCoreParts.push(chalk.dim(" "));
    rightCoreParts.push(chalk.yellow("▲"));
  }
  rightCoreParts.push(chalk.dim("]"));
  if (context.isLocalBackend) {
    rightCoreParts.push(chalk.dim(" · "));
    rightCoreParts.push(chalk.hex(colors.status.success)("local"));
  }

  const rightCore = rightCoreParts.join("");
  const right = context.goalStatusText
    ? chalk.magenta(context.goalStatusText)
    : " ".repeat(rightPrefixSpaces) + rightCore;

  return {
    left: <CommandHintSegment />,
    right,
    rightCore,
    rightWidth,
  };
}

export const legacyStatuslineRenderer: StatuslineRenderer = {
  id: "legacy",
  label: "Legacy",
  description: "The existing detailed Letta Code status line.",
  render: renderLegacyStatusline,
};
