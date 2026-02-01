import { Box } from "ink";
import type React from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth.js";
import { colors } from "./colors.js";
import { Text } from "./Text";

interface PlanItem {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

interface PlanRendererProps {
  plan: PlanItem[];
  explanation?: string;
}

export const PlanRenderer: React.FC<PlanRendererProps> = ({
  plan,
  explanation,
}) => {
  const columns = useTerminalWidth();
  const prefixWidth = 5; // "  ⎿  " or "     "
  const contentWidth = Math.max(0, columns - prefixWidth);

  return (
    <Box flexDirection="column">
      {explanation && (
        <Box flexDirection="row">
          <Box width={prefixWidth} flexShrink={0}>
            <Text>{"  ⎿  "}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text italic dimColor wrap="wrap">
              {explanation}
            </Text>
          </Box>
        </Box>
      )}
      {plan.map((item, index) => {
        const checkbox = item.status === "completed" ? "☒" : "☐";

        // Format based on status
        let textElement: React.ReactNode;
        if (item.status === "completed") {
          // Green with strikethrough
          textElement = (
            <Text color={colors.todo.completed} strikethrough wrap="wrap">
              {checkbox} {item.step}
            </Text>
          );
        } else if (item.status === "in_progress") {
          // Blue bold
          textElement = (
            <Text color={colors.todo.inProgress} bold wrap="wrap">
              {checkbox} {item.step}
            </Text>
          );
        } else {
          // Plain text for pending
          textElement = (
            <Text wrap="wrap">
              {checkbox} {item.step}
            </Text>
          );
        }

        // First item (or first after explanation) gets the prefix, others get indentation
        const prefix = index === 0 && !explanation ? "  ⎿  " : "     ";

        return (
          <Box key={`${index}-${item.step.slice(0, 20)}`} flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text>{prefix}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              {textElement}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};
