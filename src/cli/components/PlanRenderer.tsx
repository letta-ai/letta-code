import { Box, Text } from "ink";
import type React from "react";
import { colors } from "./colors.js";

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
  return (
    <Box flexDirection="column">
      {explanation && (
        <Box>
          <Text>{"  ⎿  "}</Text>
          <Text italic dimColor>
            {explanation}
          </Text>
        </Box>
      )}
      {plan.map((item, index) => {
        const checkbox = item.status === "completed" ? "☒" : "☐";

        // Format based on status
        let textElement: React.ReactNode;
        if (item.status === "completed") {
          // Green with strikethrough
          textElement = (
            <Text color={colors.todo.completed} strikethrough>
              {checkbox} {item.step}
            </Text>
          );
        } else if (item.status === "in_progress") {
          // Blue bold
          textElement = (
            <Text color={colors.todo.inProgress} bold>
              {checkbox} {item.step}
            </Text>
          );
        } else {
          // Plain text for pending
          textElement = (
            <Text>
              {checkbox} {item.step}
            </Text>
          );
        }

        // First item (or first after explanation) gets the prefix, others get indentation
        const prefix = index === 0 && !explanation ? "  ⎿  " : "     ";

        return (
          <Box key={`${index}-${item.step.slice(0, 20)}`}>
            <Text>{prefix}</Text>
            {textElement}
          </Box>
        );
      })}
    </Box>
  );
};
