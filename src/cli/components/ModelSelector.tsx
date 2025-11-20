// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { models } from "../../agent/model";
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
  const [showAll, setShowAll] = useState(false);

  const frontierModels = models.filter((m) => m.isFrontier);
  const displayedModels = showAll ? models : frontierModels;
  const maxIndex = showAll ? models.length - 1 : frontierModels.length;

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(maxIndex, prev + 1));
    } else if (key.return) {
      if (!showAll && selectedIndex === frontierModels.length) {
        setShowAll(true);
        setSelectedIndex(0);
      } else {
        const selectedModel = displayedModels[selectedIndex];
        if (selectedModel) {
          onSelect(selectedModel.id);
        }
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
        {displayedModels.map((model, index) => {
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
        {!showAll && (
          <Box flexDirection="row" gap={1}>
            <Text
              color={
                selectedIndex === frontierModels.length
                  ? colors.selector.itemHighlighted
                  : undefined
              }
            >
              {selectedIndex === frontierModels.length ? "›" : " "}
            </Text>
            <Text
              bold={selectedIndex === frontierModels.length}
              color={
                selectedIndex === frontierModels.length
                  ? colors.selector.itemHighlighted
                  : undefined
              }
            >
              Show all models...
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
