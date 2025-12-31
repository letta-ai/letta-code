import { Box, Text, useInput } from "ink";
import { memo, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

type Props = {
  onApprove: () => void;
  onReject: () => void;
  isFocused?: boolean;
};

// Horizontal line character for Claude Code style
const SOLID_LINE = "─";

const OptionsRenderer = memo(
  ({
    options,
    selectedOption,
  }: {
    options: Array<{ label: string }>;
    selectedOption: number;
  }) => {
    return (
      <Box flexDirection="column">
        {options.map((option, index) => {
          const isSelected = index === selectedOption;
          const color = isSelected ? colors.approval.header : undefined;
          return (
            <Box key={option.label} flexDirection="row">
              <Text color={color}>
                {isSelected ? "❯" : " "} {index + 1}. {option.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  },
);

OptionsRenderer.displayName = "OptionsRenderer";

/**
 * InlineEnterPlanModeApproval - Renders EnterPlanMode approval UI inline
 *
 * Uses horizontal lines instead of boxes for visual styling.
 */
export const InlineEnterPlanModeApproval = memo(
  ({ onApprove, onReject, isFocused = true }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const columns = useTerminalWidth();

    const options = [
      { label: "Yes, enter plan mode", action: onApprove },
      { label: "No, start implementing now", action: onReject },
    ];

    useInput(
      (input, key) => {
        if (!isFocused) return;

        // CTRL-C: immediately reject (cancel)
        if (key.ctrl && input === "c") {
          onReject();
          return;
        }

        // ESC: reject (cancel)
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
      },
      { isActive: isFocused },
    );

    // Generate horizontal line
    const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));

    return (
      <Box flexDirection="column">
        {/* Top solid line */}
        <Text dimColor>{solidLine}</Text>

        {/* Header */}
        <Text bold color={colors.approval.header}>
          Enter plan mode?
        </Text>

        <Box height={1} />

        {/* Description */}
        <Box flexDirection="column" paddingLeft={2}>
          <Text>
            Letta Code wants to enter plan mode to explore and design an
            implementation approach.
          </Text>
          <Box height={1} />
          <Text>In plan mode, Letta Code will:</Text>
          <Text> · Explore the codebase thoroughly</Text>
          <Text> · Identify existing patterns</Text>
          <Text> · Design an implementation strategy</Text>
          <Text> · Present a plan for your approval</Text>
          <Box height={1} />
          <Text dimColor>
            No code changes will be made until you approve the plan.
          </Text>
        </Box>

        {/* Options */}
        <Box marginTop={1}>
          <OptionsRenderer options={options} selectedOption={selectedOption} />
        </Box>
      </Box>
    );
  },
);

InlineEnterPlanModeApproval.displayName = "InlineEnterPlanModeApproval";
