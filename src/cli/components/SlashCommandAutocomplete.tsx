import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { commands } from "../commands/registry";
import { colors } from "./colors";

interface CommandMatch {
  cmd: string;
  desc: string;
}

interface SlashCommandAutocompleteProps {
  currentInput: string;
  cursorPosition?: number;
  onSelect?: (command: string) => void;
  onActiveChange?: (isActive: boolean) => void;
}

// Compute filtered command list (excluding hidden commands)
const allCommands = Object.entries(commands)
  .filter(([, { hidden }]) => !hidden)
  .map(([cmd, { desc }]) => ({
    cmd,
    desc,
  }))
  .sort((a, b) => a.cmd.localeCompare(b.cmd));

export function SlashCommandAutocomplete({
  currentInput,
  cursorPosition = currentInput.length,
  onSelect,
  onActiveChange,
}: SlashCommandAutocompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Extract the text after the "/" symbol where the cursor is positioned
  const extractSearchQuery = useCallback(
    (
      input: string,
      cursor: number,
    ): { query: string; hasSpaceAfter: boolean; slashIndex: number } | null => {
      // Only trigger if input starts with "/"
      if (!input.startsWith("/")) return null;

      const slashIndex = 0;

      // Find the end of this /command (next space or end of string)
      const afterSlash = input.slice(slashIndex + 1);
      const spaceIndex = afterSlash.indexOf(" ");
      const endPos =
        spaceIndex === -1 ? input.length : slashIndex + 1 + spaceIndex;

      // Check if cursor is within this /command
      if (cursor < slashIndex || cursor > endPos) {
        return null;
      }

      // Get text after "/" until next space or end
      const query = spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);
      const hasSpaceAfter = spaceIndex !== -1;

      return { query, hasSpaceAfter, slashIndex };
    },
    [],
  );

  // Filter commands based on query
  const matches = useMemo((): CommandMatch[] => {
    const result = extractSearchQuery(currentInput, cursorPosition);

    if (!result) return [];

    const { query, hasSpaceAfter } = result;

    // If there's a space after the command, user has moved on - hide autocomplete
    if (hasSpaceAfter) {
      return [];
    }

    // If query is empty (just typed "/"), show all commands
    if (query.length === 0) {
      return allCommands;
    }

    // Filter commands that contain the query (case-insensitive)
    // Match against the command name without the leading "/"
    const lowerQuery = query.toLowerCase();
    return allCommands.filter((item) => {
      const cmdName = item.cmd.slice(1).toLowerCase(); // Remove leading "/"
      return cmdName.includes(lowerQuery);
    });
  }, [currentInput, cursorPosition, extractSearchQuery]);

  // Reset selected index when matches change
  useEffect(() => {
    setSelectedIndex(0);
  }, [matches.length]);

  // Notify parent about active state changes
  useEffect(() => {
    onActiveChange?.(matches.length > 0);
  }, [matches.length, onActiveChange]);

  // Handle keyboard navigation
  useInput((_input, key) => {
    if (!matches.length) return;

    const maxIndex = Math.min(matches.length, 10) - 1;

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
    } else if ((key.tab || key.return) && onSelect) {
      // Insert selected command on Tab or Enter
      const selected = matches[selectedIndex];
      if (selected) {
        onSelect(selected.cmd);
      }
    }
  });

  // Don't show if input doesn't start with "/"
  if (!currentInput.startsWith("/")) {
    return null;
  }

  // Don't show if no matches
  if (matches.length === 0) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.command.border}
      paddingX={1}
      marginBottom={1}
    >
      <Text dimColor>
        Slash commands (↑↓ to navigate, Tab/Enter to select):
      </Text>
      {matches.slice(0, 10).map((item, idx) => (
        <Box key={item.cmd} flexDirection="row" gap={1}>
          <Text
            color={idx === selectedIndex ? colors.status.success : undefined}
            bold={idx === selectedIndex}
          >
            {idx === selectedIndex ? "▶ " : "  "}
            {"⚡"}
          </Text>
          <Text bold={idx === selectedIndex}>
            {item.cmd.padEnd(15)}{" "}
            <Text dimColor={idx !== selectedIndex}>{item.desc}</Text>
          </Text>
        </Box>
      ))}
      {matches.length > 10 && (
        <Text dimColor>... and {matches.length - 10} more</Text>
      )}
    </Box>
  );
}
