import { Box, useInput } from "ink";
import { useState } from "react";
import {
  PERSONALITY_OPTIONS,
  type PersonalityId,
} from "../../agent/personality";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";

interface PersonalitySelectorProps {
  currentPersonalityId?: PersonalityId;
  onSelect: (personalityId: PersonalityId) => void;
  onCancel: () => void;
}

export function PersonalitySelector({
  currentPersonalityId,
  onSelect,
  onCancel,
}: PersonalitySelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) =>
        Math.min(PERSONALITY_OPTIONS.length - 1, prev + 1),
      );
      return;
    }

    if (key.return) {
      const selected = PERSONALITY_OPTIONS[selectedIndex];
      if (selected) {
        onSelect(selected.id);
      }
      return;
    }

    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /personality"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Swap your agent personality
        </Text>
      </Box>

      <Box flexDirection="column">
        {PERSONALITY_OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = option.id === currentPersonalityId;

          return (
            <Box key={option.id} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
              </Text>
              <Text
                bold={isSelected}
                color={
                  isSelected
                    ? colors.selector.itemHighlighted
                    : isCurrent
                      ? colors.selector.itemCurrent
                      : undefined
                }
              >
                {option.label}
                {isCurrent && " (current)"}
              </Text>
              <Text dimColor> ({option.description})</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}
