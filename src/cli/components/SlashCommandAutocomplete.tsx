import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
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
const allCommands: CommandMatch[] = Object.entries(commands)
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
  const [matches, setMatches] = useState<CommandMatch[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevMatchCountRef = useRef(0);

  // Extract the text after the "/" symbol where the cursor is positioned
  const extractSearchQuery = useCallback(
    (
      input: string,
      cursor: number,
    ): { query: string; hasSpaceAfter: boolean } | null => {
      // Only trigger if input starts with "/"
      if (!input.startsWith("/")) return null;

      // Find the end of this /command (next space or end of string)
      const afterSlash = input.slice(1);
      const spaceIndex = afterSlash.indexOf(" ");
      const endPos = spaceIndex === -1 ? input.length : 1 + spaceIndex;

      // Check if cursor is within this /command
      if (cursor < 0 || cursor > endPos) {
        return null;
      }

      // Get text after "/" until next space or end
      const query = spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);
      const hasSpaceAfter = spaceIndex !== -1;

      return { query, hasSpaceAfter };
    },
    [],
  );

  // Update matches when input changes
  useEffect(() => {
    const result = extractSearchQuery(currentInput, cursorPosition);

    if (!result) {
      setMatches([]);
      setSelectedIndex(0);
      return;
    }

    const { query, hasSpaceAfter } = result;

    // If there's a space after the command, user has moved on - hide autocomplete
    if (hasSpaceAfter) {
      setMatches([]);
      setSelectedIndex(0);
      return;
    }

    let newMatches: CommandMatch[];

    // If query is empty (just typed "/"), show all commands
    if (query.length === 0) {
      newMatches = allCommands;
    } else {
      // Filter commands that contain the query (case-insensitive)
      // Match against the command name without the leading "/"
      const lowerQuery = query.toLowerCase();
      newMatches = allCommands.filter((item) => {
        const cmdName = item.cmd.slice(1).toLowerCase(); // Remove leading "/"
        return cmdName.includes(lowerQuery);
      });
    }

    setMatches(newMatches);
    
    // Reset selected index when matches change
    if (newMatches.length !== prevMatchCountRef.current) {
      setSelectedIndex(0);
      prevMatchCountRef.current = newMatches.length;
    }
  }, [currentInput, cursorPosition, extractSearchQuery]);

  // Notify parent about active state changes
  useEffect(() => {
    onActiveChange?.(matches.length > 0);
  }, [matches.length, onActiveChange]);

  // Handle keyboard navigation
  useInput((_input, key) => {
    if (!matches.length) return;

    const maxIndex = matches.length - 1;

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
        ↑↓ navigate, Tab/Enter select
      </Text>
      {matches.map((item, idx) => (
        <Text key={item.cmd} color={idx === selectedIndex ? colors.command.selected : undefined} bold={idx === selectedIndex}>
          {idx === selectedIndex ? "▶ " : "  "}{item.cmd.padEnd(14)} <Text dimColor={idx !== selectedIndex}>{item.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}
