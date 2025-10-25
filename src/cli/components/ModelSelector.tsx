// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import models from "../../models.json";
import { colors } from "./colors";

interface ModelSelectorProps {
  currentModel?: string;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

export function ModelSelector({
  currentModel,
  onSelect,
  onCancel,
}: ModelSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(models.length - 1, prev + 1));
    } else if (key.return) {
      const selectedModel = models[selectedIndex];
      if (selectedModel) {
        onSelect(selectedModel.id);
      }
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Select Model (↑↓ to navigate, Enter to select, ESC to cancel)
        </Text>
      </Box>

      <Box flexDirection="column">
        {models.map((model, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = model.handle === currentModel;

          return (
            <Box key={model.id} flexDirection="row" gap={1}>
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "›" : " "}
              </Text>
              <Box flexDirection="row">
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {model.label}
                  {isCurrent && (
                    <Text color={colors.selector.itemCurrent}> (current)</Text>
                  )}
                </Text>
                <Text dimColor> {model.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
