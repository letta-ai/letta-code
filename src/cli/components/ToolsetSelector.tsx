// Import useInput from vendored Ink for bracketed paste support
import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { ToolsetName, ToolsetPreference } from "../../tools/toolset";
import { formatToolsetName } from "../../tools/toolset-labels";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

interface ToolsetOption {
  id: ToolsetPreference;
  label: string;
  description: string;
  isFeatured?: boolean;
}

const toolsets: ToolsetOption[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Auto-select based on the model",
    isFeatured: true,
  },
  {
    id: "none",
    label: "None",
    description: "Remove all Letta Code tools from your agent",
    isFeatured: true,
  },
  {
    id: "default",
    label: "Claude toolset",
    description: "Optimized for Anthropic models",
    isFeatured: true,
  },
  {
    id: "codex",
    label: "Codex toolset",
    description: "Optimized for GPT/Codex models",
    isFeatured: true,
  },
  {
    id: "gemini",
    label: "Gemini toolset",
    description: "Optimized for Google Gemini models",
    isFeatured: true,
  },
  {
    id: "codex_snake",
    label: "Codex toolset (snake_case)",
    description: "Optimized for GPT/Codex models (snake_case)",
  },
  {
    id: "gemini_snake",
    label: "Gemini toolset (snake_case)",
    description: "Optimized for Google Gemini models (snake_case)",
  },
];

interface ToolsetSelectorProps {
  currentToolset?: ToolsetName;
  currentPreference?: ToolsetPreference;
  onSelect: (toolsetId: ToolsetPreference) => void;
  onCancel: () => void;
}

export function ToolsetSelector({
  currentToolset,
  currentPreference = "auto",
  onSelect,
  onCancel,
}: ToolsetSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [showAll, setShowAll] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const featuredToolsets = useMemo(
    () => toolsets.filter((toolset) => toolset.isFeatured),
    [],
  );

  const visibleToolsets = useMemo(() => {
    if (showAll) return toolsets;
    if (featuredToolsets.length > 0) return featuredToolsets;
    return toolsets;
  }, [featuredToolsets, showAll]);

  const canToggleShowAll = featuredToolsets.length < toolsets.length;

  useEffect(() => {
    if (selectedIndex >= visibleToolsets.length) {
      setSelectedIndex(Math.max(0, visibleToolsets.length - 1));
    }
  }, [selectedIndex, visibleToolsets.length]);

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) =>
        Math.min(visibleToolsets.length - 1, prev + 1),
      );
    } else if (key.return) {
      const selectedToolset = visibleToolsets[selectedIndex];
      if (selectedToolset) {
        onSelect(selectedToolset.id);
      }
    } else if (canToggleShowAll && (input === "a" || input === "A")) {
      setShowAll((prev) => !prev);
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /toolset"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Swap your agent's toolset
        </Text>
      </Box>

      <Box flexDirection="column">
        {visibleToolsets.map((toolset, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = toolset.id === currentPreference;

          const labelText =
            toolset.id === "auto"
              ? isCurrent
                ? `Auto (current - ${formatToolsetName(currentToolset)})`
                : "Auto"
              : isCurrent
                ? `${toolset.label} (current)`
                : toolset.label;

          return (
            <Box key={toolset.id} flexDirection="row">
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
                {labelText}
              </Text>
              <Text dimColor>{` · ${toolset.description}`}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {canToggleShowAll
            ? "  Enter select · ↑↓ navigate · A show all · Esc cancel"
            : "  Enter select · ↑↓ navigate · Esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}
