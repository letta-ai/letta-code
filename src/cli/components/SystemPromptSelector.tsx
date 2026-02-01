// Import useInput from vendored Ink for bracketed paste support
import { Box, useInput } from "ink";
import { useMemo, useState } from "react";
import { SYSTEM_PROMPTS } from "../../agent/promptAssets";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

interface SystemPromptSelectorProps {
  currentPromptId?: string;
  onSelect: (promptId: string) => void;
  onCancel: () => void;
}

export function SystemPromptSelector({
  currentPromptId,
  onSelect,
  onCancel,
}: SystemPromptSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [showAll, setShowAll] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const featuredPrompts = useMemo(
    () => SYSTEM_PROMPTS.filter((prompt) => prompt.isFeatured),
    [],
  );

  const visiblePrompts = useMemo(() => {
    if (showAll) return SYSTEM_PROMPTS;
    if (featuredPrompts.length > 0) return featuredPrompts;
    return SYSTEM_PROMPTS.slice(0, 3);
  }, [featuredPrompts, showAll]);

  const hasHiddenPrompts = visiblePrompts.length < SYSTEM_PROMPTS.length;
  const hasShowAllOption = !showAll && hasHiddenPrompts;

  const totalItems = visiblePrompts.length + (hasShowAllOption ? 1 : 0);

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
    } else if (key.return) {
      if (hasShowAllOption && selectedIndex === visiblePrompts.length) {
        setShowAll(true);
        setSelectedIndex(0);
      } else {
        const selectedPrompt = visiblePrompts[selectedIndex];
        if (selectedPrompt) {
          onSelect(selectedPrompt.id);
        }
      }
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /prompt"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Swap your agent's system prompt
        </Text>
      </Box>

      <Box flexDirection="column">
        {visiblePrompts.map((prompt, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = prompt.id === currentPromptId;

          return (
            <Box key={prompt.id} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {prompt.label}
                {isCurrent && (
                  <Text color={colors.selector.itemCurrent}> (current)</Text>
                )}
              </Text>
              <Text dimColor> · {prompt.description}</Text>
            </Box>
          );
        })}
        {hasShowAllOption && (
          <Box flexDirection="row">
            <Text
              color={
                selectedIndex === visiblePrompts.length
                  ? colors.selector.itemHighlighted
                  : undefined
              }
            >
              {selectedIndex === visiblePrompts.length ? "> " : "  "}
            </Text>
            <Text dimColor>Show all prompts</Text>
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}
