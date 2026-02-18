// Import useInput from vendored Ink for bracketed paste support
import { Box, useInput } from "ink";
import { useMemo, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

type ToolsetId =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake"
  | "none";

interface ToolsetOption {
  id: ToolsetId;
  label: string;
  description: string;
  tools: string[];
  isFeatured?: boolean;
}

const toolsets: ToolsetOption[] = [
  {
    id: "default",
    label: "Default Tools",
    description: "Toolset optimized for Claude models",
    tools: [
      "Bash",
      "TaskOutput",
      "Edit",
      "Glob",
      "Grep",
      "LS",
      "MultiEdit",
      "Read",
      "TodoWrite",
      "Write",
    ],
    isFeatured: true,
  },
  {
    id: "codex",
    label: "Codex Tools",
    description: "Toolset optimized for GPT/Codex models",
    tools: [
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "Task",
      "Skill",
      "ShellCommand",
      "ApplyPatch",
      "UpdatePlan",
      "ViewImage",
    ],
    isFeatured: true,
  },
  {
    id: "codex_snake",
    label: "Codex Tools (snake_case)",
    description: "Toolset optimized for GPT/Codex models (snake_case)",
    tools: ["shell_command", "apply_patch", "update_plan", "view_image"],
  },
  {
    id: "gemini",
    label: "Gemini Tools",
    description: "Toolset optimized for Gemini models",
    tools: [
      "RunShellCommand",
      "ReadFileGemini",
      "ListDirectory",
      "GlobGemini",
      "SearchFileContent",
      "Replace",
      "WriteFileGemini",
      "WriteTodos",
      "ReadManyFiles",
    ],
    isFeatured: true,
  },
  {
    id: "gemini_snake",
    label: "Gemini Tools (snake_case)",
    description: "Toolset optimized for Gemini models (snake_case)",
    tools: [
      "run_shell_command",
      "read_file_gemini",
      "list_directory",
      "glob_gemini",
      "search_file_content",
      "replace",
      "write_file_gemini",
      "write_todos",
      "read_many_files",
    ],
  },
  {
    id: "none",
    label: "None (Disable Tools)",
    description: "Remove all Letta Code tools from the agent",
    tools: [],
    isFeatured: true,
  },
];

interface ToolsetSelectorProps {
  currentToolset?: ToolsetId;
  onSelect: (toolsetId: ToolsetId) => void;
  onCancel: () => void;
}

export function ToolsetSelector({
  currentToolset,
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
    return toolsets.slice(0, 3);
  }, [featuredToolsets, showAll]);

  const hasHiddenToolsets = visibleToolsets.length < toolsets.length;
  const hasShowAllOption = !showAll && hasHiddenToolsets;

  const totalItems = visibleToolsets.length + (hasShowAllOption ? 1 : 0);

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
      if (hasShowAllOption && selectedIndex === visibleToolsets.length) {
        setShowAll(true);
        setSelectedIndex(0);
      } else {
        const selectedToolset = visibleToolsets[selectedIndex];
        if (selectedToolset) {
          onSelect(selectedToolset.id);
        }
      }
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
          const isCurrent = toolset.id === currentToolset;

          return (
            <Box key={toolset.id} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "> " : "  "}
                </Text>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {toolset.label}
                  {isCurrent && (
                    <Text color={colors.selector.itemCurrent}> (current)</Text>
                  )}
                </Text>
              </Box>
              <Text dimColor>
                {"  "}
                {toolset.description}
              </Text>
            </Box>
          );
        })}
        {hasShowAllOption && (
          <Box flexDirection="row">
            <Text
              color={
                selectedIndex === visibleToolsets.length
                  ? colors.selector.itemHighlighted
                  : undefined
              }
            >
              {selectedIndex === visibleToolsets.length ? "> " : "  "}
            </Text>
            <Text dimColor>Show all toolsets</Text>
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
