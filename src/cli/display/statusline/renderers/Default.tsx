import chalk from "chalk";
import type { ReactNode } from "react";
import { colors } from "@/cli/components/colors";
import { Box, Text } from "@/cli/display/DisplayComponents";
import { truncateStatuslineText } from "@/cli/display/statusline/formatting";
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
} from "@/cli/display/statusline/types";

interface DefaultStatuslineParts {
  left: ReactNode;
  right: string;
  rightCore: string;
  rightWidth: number;
}

export function getDefaultStatuslineRightColumnWidth(
  context: StatuslineRenderContext,
): number {
  const terminalWidth = context.terminalWidth ?? context.ui.rightColumnWidth;
  return Math.max(context.ui.rightColumnWidth, terminalWidth - 4);
}

export function buildDefaultStatuslineParts(
  context: StatuslineRenderContext,
  rightColumnWidth = getDefaultStatuslineRightColumnWidth(context),
): DefaultStatuslineParts {
  const indicatorWidth =
    (context.ui.isByokProvider ? 2 : 0) +
    (context.ui.hasTemporaryModelOverride ? 2 : 0);
  const separatorWidth = 3;
  const availableTextWidth = Math.max(
    12,
    rightColumnWidth - separatorWidth - indicatorWidth,
  );
  const maxAgentChars = Math.max(8, Math.floor(availableTextWidth * 0.4));
  const displayAgentName = truncateStatuslineText(
    context.agent.name || "Unnamed",
    maxAgentChars,
  );
  const maxModelChars = Math.max(
    8,
    availableTextWidth - displayAgentName.length,
  );
  const displayModel = truncateStatuslineText(
    context.model.displayName ?? "unknown",
    maxModelChars,
  );

  const rightWidth =
    displayAgentName.length +
    separatorWidth +
    displayModel.length +
    indicatorWidth;
  const rightPrefixSpaces = Math.max(0, rightColumnWidth - rightWidth);

  const rightCoreParts: string[] = [];
  rightCoreParts.push(chalk.hex(colors.footer.agentName)(displayAgentName));
  rightCoreParts.push(chalk.dim(" · "));
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

  const rightCore = rightCoreParts.join("");
  const right = " ".repeat(rightPrefixSpaces) + rightCore;

  return {
    left: <Text> </Text>,
    right,
    rightCore,
    rightWidth,
  };
}

export function renderDefaultStatusline(context: StatuslineRenderContext) {
  const rightColumnWidth = getDefaultStatuslineRightColumnWidth(context);
  const parts = buildDefaultStatuslineParts(context, rightColumnWidth);

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexGrow={1} paddingRight={1}>
        {parts.left}
      </Box>
      <Box
        flexDirection="column"
        alignItems="flex-end"
        width={rightColumnWidth}
        flexShrink={0}
      >
        <Text>{parts.right}</Text>
      </Box>
    </Box>
  );
}

export const defaultStatuslineRenderer: StatuslineRenderer = {
  id: "default",
  label: "Default",
  description: "The built-in Letta Code statusline.",
  render: renderDefaultStatusline,
};
