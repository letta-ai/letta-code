// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { models } from "../../agent/model";
import { colors } from "./colors";

type UiModel = {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  updateArgs?: Record<string, unknown>;
};

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
  const typedModels = models as UiModel[];
  const [showAll, setShowAll] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const featuredModels = useMemo(
    () => typedModels.filter((model) => model.isFeatured),
    [typedModels],
  );

  const visibleModels = useMemo(() => {
    if (showAll) return typedModels;
    if (featuredModels.length > 0) return featuredModels;
    return typedModels.slice(0, 5);
  }, [featuredModels, showAll, typedModels]);

  // Set initial selection to current model on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current) {
      const index = visibleModels.findIndex((m) => m.handle === currentModel);
      if (index >= 0) {
        setSelectedIndex(index);
      }
      initializedRef.current = true;
    }
  }, [visibleModels, currentModel]);

  const totalItems = showAll ? visibleModels.length : visibleModels.length + 1;

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
    } else if (key.return) {
      if (!showAll && selectedIndex === visibleModels.length) {
        setShowAll(true);
        setSelectedIndex(0);
      } else {
        const selectedModel = visibleModels[selectedIndex];
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
        {visibleModels.map((model, index) => {
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
                selectedIndex === visibleModels.length
                  ? colors.selector.itemHighlighted
                  : undefined
              }
            >
              {selectedIndex === visibleModels.length ? "›" : " "}
            </Text>
            <Text dimColor>Show all models</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
