import chalk from "chalk";
import type { ReactNode } from "react";
import { colors } from "@/cli/components/colors";
import { Box, Text } from "@/cli/display/DisplayComponents";
import {
  formatStatuslineReasoningEffort,
  truncateStatuslineText,
} from "@/cli/display/statusline/formatting";
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
} from "@/cli/display/statusline/types";
import { shouldHideReasoningForModelDisplay } from "@/cli/helpers/startup-model-display";

interface LegacyStatuslineParts {
  left: ReactNode;
  right: string;
  rightCore: string;
  rightWidth: number;
}

export function buildLegacyStatuslineParts(
  context: StatuslineRenderContext,
): LegacyStatuslineParts {
  const maxAgentChars = Math.max(
    10,
    Math.floor(context.ui.rightColumnWidth * 0.45),
  );
  const displayAgentName = truncateStatuslineText(
    context.agent.name || "Unnamed",
    maxAgentChars,
  );
  const reasoningTag = shouldHideReasoningForModelDisplay(
    context.model.displayName,
  )
    ? null
    : formatStatuslineReasoningEffort(context.model.reasoningEffort);
  const byokExtraChars = context.ui.isByokProvider ? 2 : 0;
  const tempOverrideExtraChars = context.ui.hasTemporaryModelOverride ? 2 : 0;

  const baseReservedChars =
    displayAgentName.length + byokExtraChars + tempOverrideExtraChars + 4;
  const modelWithReasoning =
    (context.model.displayName ?? "unknown") +
    (reasoningTag ? ` (${reasoningTag})` : "");

  const maxModelChars = Math.max(
    8,
    context.ui.rightColumnWidth - baseReservedChars,
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
  const rightPrefixSpaces = Math.max(
    0,
    context.ui.rightColumnWidth - rightWidth,
  );

  const rightCoreParts: string[] = [];
  rightCoreParts.push(chalk.hex(colors.footer.agentName)(displayAgentName));
  rightCoreParts.push(chalk.dim(" ["));
  rightCoreParts.push(chalk.dim(displayModel));
  if (context.ui.isByokProvider) {
    rightCoreParts.push(chalk.dim(" "));
    rightCoreParts.push(
      context.ui.isOpenAICodexProvider
        ? chalk.hex("#74AA9C")("▲")
        : chalk.yellow("▲"),
    );
  }
  if (context.ui.hasTemporaryModelOverride) {
    rightCoreParts.push(chalk.dim(" "));
    rightCoreParts.push(chalk.yellow("▲"));
  }
  rightCoreParts.push(chalk.dim("]"));
  if (context.ui.isLocalBackend) {
    rightCoreParts.push(chalk.dim(" · "));
    rightCoreParts.push(chalk.hex(colors.status.success)("local"));
  }

  const rightCore = rightCoreParts.join("");
  const right = context.ui.goalStatusText
    ? chalk.magenta(context.ui.goalStatusText)
    : " ".repeat(rightPrefixSpaces) + rightCore;

  return {
    left: <Text dimColor>Press / for commands</Text>,
    right,
    rightCore,
    rightWidth,
  };
}

export function renderLegacyStatusline(context: StatuslineRenderContext) {
  const parts = buildLegacyStatuslineParts(context);

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexGrow={1} paddingRight={1}>
        {parts.left}
      </Box>
      <Box
        flexDirection="column"
        alignItems="flex-end"
        width={context.ui.rightColumnWidth}
        flexShrink={0}
      >
        <Text>{parts.right}</Text>
      </Box>
    </Box>
  );
}

export const legacyStatuslineRenderer: StatuslineRenderer = {
  id: "legacy",
  label: "Legacy",
  description: "The existing detailed Letta Code status line.",
  render: renderLegacyStatusline,
};
