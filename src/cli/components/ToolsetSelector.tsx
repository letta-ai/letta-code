// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { colors } from "./colors";

interface ToolsetOption {
  id: "codex" | "default";
  label: string;
  description: string;
  tools: string[];
}

const toolsets: ToolsetOption[] = [
  {
    id: "codex",
    label: "Codex Tools",
    description: "OpenAI-style tools optimized for GPT models",
    tools: [
      "shell_command",
      "shell",
      "read_file",
      "list_dir",
      "grep_files",
      "apply_patch",
      "update_plan",
    ],
  },
  {
    id: "default",
    label: "Default Tools",
    description: "Anthropic-style tools optimized for Claude models",
    tools: [
      "Bash",
      "BashOutput",
      "Edit",
      "Glob",
      "Grep",
      "LS",
      "MultiEdit",
      "Read",
      "TodoWrite",
      "Write",
    ],
  },
];

interface ToolsetSelectorProps {
  currentToolset?: "codex" | "default";
  onSelect: (toolsetId: "codex" | "default") => void;
  onCancel: () => void;
}

export function ToolsetSelector({
  currentToolset,
  onSelect,
  onCancel,
}: ToolsetSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(toolsets.length - 1, prev + 1));
    } else if (key.return) {
      const selectedToolset = toolsets[selectedIndex];
      if (selectedToolset) {
        onSelect(selectedToolset.id);
      }
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Select Toolset (↑↓ to navigate, Enter to select, ESC to cancel)
        </Text>
      </Box>

      <Box flexDirection="column">
        {toolsets.map((toolset, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = toolset.id === currentToolset;

          return (
            <Box key={toolset.id} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "›" : " "}
                </Text>
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {toolset.label}
                      {isCurrent && (
                        <Text color={colors.selector.itemCurrent}>
                          {" "}
                          (current)
                        </Text>
                      )}
                    </Text>
                  </Box>
                  <Text dimColor> {toolset.description}</Text>
                </Box>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
