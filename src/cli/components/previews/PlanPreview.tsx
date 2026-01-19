import { Text } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../../hooks/useTerminalWidth";
import { colors } from "../colors";
import { MarkdownDisplay } from "../MarkdownDisplay";

const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

type Props = {
  plan: string;
};

/**
 * PlanPreview - Renders the plan content preview (no interactive options)
 *
 * Used by:
 * - InlinePlanApproval/StaticPlanApproval for memoized content
 * - Static area for eagerly-committed plan previews
 */
export const PlanPreview = memo(({ plan }: Props) => {
  const columns = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));
  const dottedLine = DOTTED_LINE.repeat(Math.max(columns - 2, 10));

  return (
    <>
      {/* Top solid line */}
      <Text dimColor>{solidLine}</Text>

      {/* Header */}
      <Text bold color={colors.approval.header}>
        Ready to code? Here is your plan:
      </Text>

      {/* Dotted separator before plan content */}
      <Text dimColor>{dottedLine}</Text>

      {/* Plan content */}
      <MarkdownDisplay text={plan} />

      {/* Dotted separator after plan content */}
      <Text dimColor>{dottedLine}</Text>
    </>
  );
});

PlanPreview.displayName = "PlanPreview";
