import { Box, Text, useInput } from "ink";
import RawTextInput from "ink-text-input";
import { type ComponentType, memo, useState } from "react";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";

type Props = {
  plan: string;
  onApprove: () => void;
  onApproveAndAcceptEdits: () => void;
  onKeepPlanning: (reason: string) => void;
};

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

export const PlanModeDialog = memo(
  ({ plan, onApprove, onApproveAndAcceptEdits, onKeepPlanning }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const [isEnteringReason, setIsEnteringReason] = useState(false);
    const [denyReason, setDenyReason] = useState("");

    const options = [
      { label: "Yes, and auto-accept edits", action: onApproveAndAcceptEdits },
      { label: "Yes, and manually approve edits", action: onApprove },
      { label: "No, keep planning", action: () => {} }, // Handled via setIsEnteringReason
    ];

    useInput((_input, key) => {
      if (isEnteringReason) {
        // When entering reason, only handle enter/escape
        if (key.return) {
          onKeepPlanning(denyReason);
          setIsEnteringReason(false);
          setDenyReason("");
        } else if (key.escape) {
          setIsEnteringReason(false);
          setDenyReason("");
        }
        return;
      }

      if (key.upArrow) {
        setSelectedOption((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedOption((prev) => Math.min(options.length - 1, prev + 1));
      } else if (key.return) {
        // Check if this is the "keep planning" option (last option)
        if (selectedOption === options.length - 1) {
          setIsEnteringReason(true);
        } else {
          options[selectedOption]?.action();
        }
      } else if (key.escape) {
        setIsEnteringReason(true); // ESC also goes to denial input
      }
    });

    // Show denial input screen if entering reason
    if (isEnteringReason) {
      return (
        <Box flexDirection="column">
          <Box
            borderStyle="round"
            borderColor={colors.approval.border}
            width="100%"
            flexDirection="column"
            paddingX={1}
          >
            <Text bold>
              Enter feedback to continue planning (ESC to cancel):
            </Text>
            <Box height={1} />
            <Box>
              <Text dimColor>{"> "}</Text>
              {(() => {
                const TextInputAny = RawTextInput as unknown as ComponentType<{
                  value: string;
                  onChange: (s: string) => void;
                }>;
                return (
                  <TextInputAny value={denyReason} onChange={setDenyReason} />
                );
              })()}
            </Box>
          </Box>
          <Box height={1} />
        </Box>
      );
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={colors.approval.border}
        paddingX={1}
      >
        <Text bold color={colors.approval.header}>
          Ready to code?
        </Text>
        <Box height={1} />
        <Text>Here's the proposed plan:</Text>
        <Box height={1} />

        {/* Nested box for plan content */}
        <Box borderStyle="round" paddingX={1}>
          <MarkdownDisplay text={plan} />
        </Box>

        <Box height={1} />
        <Text>Would you like to proceed?</Text>
        <Box height={1} />

        <OptionsRenderer options={options} selectedOption={selectedOption} />
      </Box>
    );
  },
);

PlanModeDialog.displayName = "PlanModeDialog";
