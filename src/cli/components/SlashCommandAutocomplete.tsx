import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { settingsManager } from "../../settings-manager";
import { commands } from "../commands/registry";
import { useAutocompleteNavigation } from "../hooks/useAutocompleteNavigation";
import { colors } from "./colors";
import type { AutocompleteProps, CommandMatch } from "./types/autocomplete";

// Compute filtered command list (excluding hidden commands)
const _allCommands: CommandMatch[] = Object.entries(commands)
  .filter(([, { hidden }]) => !hidden)
  .map(([cmd, { desc }]) => ({
    cmd,
    desc,
  }))
  .sort((a, b) => a.cmd.localeCompare(b.cmd));

// Extract the text after the "/" symbol where the cursor is positioned
function extractSearchQuery(
  input: string,
  cursor: number,
): { query: string; hasSpaceAfter: boolean } | null {
  if (!input.startsWith("/")) return null;

  const afterSlash = input.slice(1);
  const spaceIndex = afterSlash.indexOf(" ");
  const endPos = spaceIndex === -1 ? input.length : 1 + spaceIndex;

  // Check if cursor is within this /command
  if (cursor < 0 || cursor > endPos) {
    return null;
  }

  const query =
    spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);
  const hasSpaceAfter = spaceIndex !== -1;

  return { query, hasSpaceAfter };
}

export function SlashCommandAutocomplete({
  currentInput,
  cursorPosition = currentInput.length,
  onSelect,
  onAutocomplete,
  onActiveChange,
  agentId,
  workingDirectory = process.cwd(),
}: AutocompleteProps) {
  const [matches, setMatches] = useState<CommandMatch[]>([]);

  // Check pin status to conditionally show/hide pin/unpin commands
  const allCommands = useMemo(() => {
    if (!agentId) return _allCommands;

    try {
      const globalPinned = settingsManager.getGlobalPinnedAgents();
      const localPinned =
        settingsManager.getLocalPinnedAgents(workingDirectory);

      const isPinnedGlobally = globalPinned.includes(agentId);
      const isPinnedLocally = localPinned.includes(agentId);
      const isPinnedAnywhere = isPinnedGlobally || isPinnedLocally;
      const isPinnedBoth = isPinnedGlobally && isPinnedLocally;

      return _allCommands.filter((cmd) => {
        // Hide /pin if agent is pinned both locally AND globally
        if (cmd.cmd === "/pin" && isPinnedBoth) {
          return false;
        }
        // Hide /unpin if agent is not pinned anywhere
        if (cmd.cmd === "/unpin" && !isPinnedAnywhere) {
          return false;
        }
        return true;
      });
    } catch (_error) {
      // If settings aren't loaded, just show all commands
      return _allCommands;
    }
  }, [agentId, workingDirectory]);

  const { selectedIndex } = useAutocompleteNavigation({
    matches,
    onSelect: onSelect ? (item) => onSelect(item.cmd) : undefined,
    onAutocomplete: onAutocomplete ? (item) => onAutocomplete(item.cmd) : undefined,
    onActiveChange,
  });

  // Update matches when input changes
  useEffect(() => {
    const result = extractSearchQuery(currentInput, cursorPosition);

    if (!result) {
      setMatches([]);
      return;
    }

    const { query, hasSpaceAfter } = result;

    // If there's a space after the command, user has moved on - hide autocomplete
    if (hasSpaceAfter) {
      setMatches([]);
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
  }, [currentInput, cursorPosition, allCommands]);

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
      <Text dimColor>↑↓ navigate, Tab autocomplete, Enter execute</Text>
      {matches.map((item, idx) => (
        <Text
          key={item.cmd}
          color={idx === selectedIndex ? colors.command.selected : undefined}
          bold={idx === selectedIndex}
        >
          {idx === selectedIndex ? "▶ " : "  "}
          {item.cmd.padEnd(14)}{" "}
          <Text dimColor={idx !== selectedIndex}>{item.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}
