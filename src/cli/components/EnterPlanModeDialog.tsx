import { Box, useInput } from "ink";
import { memo, useState } from "react";
import { useProgressIndicator } from "../hooks/useProgressIndicator";
import { colors } from "./colors";
import { Text } from "./Text";

type Props = {
  onApprove: () => void;
  onReject: () => void;
};

export const EnterPlanModeDialog = memo(({ onApprove, onReject }: Props) => {
  const [selectedOption, setSelectedOption] = useState(0);
  useProgressIndicator();

  const options = [
    { label: "Yes, enter plan mode", action: onApprove },
    { label: "No, start implementing now", action: onReject },
  ];

  useInput((input, key) => {
    // CTRL-C: immediately reject (cancel)
    if (key.ctrl && input === "c") {
      onReject();
      return;
    }

    // ESC: reject (cancel) - was missing!
    if (key.escape) {
      onReject();
      return;
    }

    if (key.upArrow) {
      setSelectedOption((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedOption((prev) => Math.min(options.length - 1, prev + 1));
    } else if (key.return) {
      options[selectedOption]?.action();
    } else if (input === "1") {
      onApprove();
    } else if (input === "2") {
      onReject();
    }
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text color={colors.approval.header} bold>
          Enter plan mode?
        </Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text>
          Letta Code wants to enter plan mode to explore and design an
          implementation approach.
        </Text>
        <Text> </Text>
        <Text>In plan mode, Letta Code will:</Text>
        <Text> • Explore the codebase thoroughly</Text>
        <Text> • Identify existing patterns</Text>
        <Text> • Design an implementation strategy</Text>
        <Text> • Present a plan for your approval</Text>
        <Text> </Text>
        <Text dimColor>
          No code changes will be made until you approve the plan.
        </Text>
      </Box>

      <Box flexDirection="column">
        {options.map((option, index) => {
          const isSelected = index === selectedOption;
          const color = isSelected ? colors.approval.header : undefined;

          return (
            <Box key={option.label} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color={color}>{isSelected ? ">" : " "}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={color} bold={isSelected}>
                  {index + 1}. {option.label}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});

EnterPlanModeDialog.displayName = "EnterPlanModeDialog";
