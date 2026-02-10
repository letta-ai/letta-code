import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { settingsManager } from "../../settings-manager";
import { commands } from "../commands/registry";
import { useAutocompleteNavigation } from "../hooks/useAutocompleteNavigation";
import { AutocompleteBox, AutocompleteItem } from "./Autocomplete";
import { Text } from "./Text";
import type { AutocompleteProps, CommandMatch } from "./types/autocomplete";

const VISIBLE_COMMANDS = 7; // Number of commands visible at once

// Compute filtered command list (excluding hidden commands), sorted by order
const _allCommands: CommandMatch[] = Object.entries(commands)
  .filter(([, { hidden }]) => !hidden)
  .map(([cmd, { desc, order }]) => ({
    cmd,
    desc,
    order: order ?? 100, // Default order for commands without explicit order
  }))
  .sort((a, b) => a.order - b.order);

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
  const [customCommands, setCustomCommands] = useState<CommandMatch[]>([]);

  // Load custom commands once on mount
  useEffect(() => {
    import("../commands/custom.js").then(({ getCustomCommands }) => {
      getCustomCommands().then((customs) => {
        const matches: CommandMatch[] = customs.map((cmd) => ({
          cmd: `/${cmd.id}`,
          // Include source/namespace in description for disambiguation
          desc: `${cmd.description} (${cmd.source}${cmd.namespace ? `:${cmd.namespace}` : ""})`,
          order: 200 + (cmd.source === "project" ? 0 : 100),
        }));
        setCustomCommands(matches);
      });
    });
  }, []);

  // Check pin status to conditionally show/hide pin/unpin commands, merge with custom commands
  const allCommands = useMemo(() => {
    let builtins = _allCommands;

    if (agentId) {
      try {
        const globalPinned = settingsManager.getGlobalPinnedAgents();
        const localPinned =
          settingsManager.getLocalPinnedAgents(workingDirectory);

        const isPinnedGlobally = globalPinned.includes(agentId);
        const isPinnedLocally = localPinned.includes(agentId);
        const isPinnedAnywhere = isPinnedGlobally || isPinnedLocally;
        const isPinnedBoth = isPinnedGlobally && isPinnedLocally;

        builtins = _allCommands.filter((cmd) => {
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
        // If settings aren't loaded, just use all builtins
        builtins = _allCommands;
      }
    }

    // Merge with custom commands and sort by order
    return [...builtins, ...customCommands].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
  }, [agentId, workingDirectory, customCommands]);

  const queryInfo = useMemo(
    () => extractSearchQuery(currentInput, cursorPosition),
    [currentInput, cursorPosition],
  );

  const { matches, showNoMatches, hideAutocomplete } = useMemo(() => {
    if (!queryInfo) {
      return {
        matches: [] as CommandMatch[],
        showNoMatches: false,
        hideAutocomplete: true,
      };
    }

    const { query, hasSpaceAfter } = queryInfo;
    if (hasSpaceAfter) {
      return {
        matches: [] as CommandMatch[],
        showNoMatches: false,
        hideAutocomplete: true,
      };
    }

    if (query.length === 0) {
      return {
        matches: allCommands,
        showNoMatches: false,
        hideAutocomplete: allCommands.length === 0,
      };
    }

    const lowerQuery = query.toLowerCase();
    const filtered = allCommands.filter((item) => {
      const cmdName = item.cmd.slice(1).toLowerCase(); // Remove leading "/"
      return cmdName.includes(lowerQuery);
    });

    return {
      matches: filtered,
      showNoMatches: filtered.length === 0,
      hideAutocomplete: false,
    };
  }, [queryInfo, allCommands]);

  const { selectedIndex } = useAutocompleteNavigation({
    matches,
    onSelect: onSelect ? (item) => onSelect(item.cmd) : undefined,
    onAutocomplete: onAutocomplete
      ? (item) => onAutocomplete(item.cmd)
      : undefined,
    // Disable automatic active state management - we handle it manually below
    manageActiveState: false,
  });

  // Manually manage active state to include the "no matches" case
  useLayoutEffect(() => {
    const isActive = matches.length > 0;
    onActiveChange?.(isActive);
  }, [matches.length, showNoMatches, onActiveChange]);

  // Don't show if input doesn't start with "/"
  if (!currentInput.startsWith("/")) {
    return null;
  }

  // Show "no matching commands" message when query has content but no results
  if (showNoMatches) {
    return (
      <AutocompleteBox>
        <Text dimColor>{"  "}No matching commands</Text>
      </AutocompleteBox>
    );
  }

  // Don't show if no matches and query is empty (shouldn't happen, but safety check)
  if (hideAutocomplete || matches.length === 0) {
    return null;
  }

  // Calculate visible window based on selected index
  const totalMatches = matches.length;
  const needsScrolling = totalMatches > VISIBLE_COMMANDS;

  let startIndex = 0;
  if (needsScrolling) {
    // Keep selected item visible, preferring to show it in the middle
    const halfWindow = Math.floor(VISIBLE_COMMANDS / 2);
    startIndex = Math.max(0, selectedIndex - halfWindow);
    startIndex = Math.min(startIndex, totalMatches - VISIBLE_COMMANDS);
  }

  const visibleMatches = matches.slice(
    startIndex,
    startIndex + VISIBLE_COMMANDS,
  );
  const showScrollDown = startIndex + VISIBLE_COMMANDS < totalMatches;

  return (
    <AutocompleteBox>
      {visibleMatches.map((item, idx) => {
        const actualIndex = startIndex + idx;
        return (
          <AutocompleteItem
            key={item.cmd}
            selected={actualIndex === selectedIndex}
          >
            {item.cmd.padEnd(14)}{" "}
            <Text dimColor={actualIndex !== selectedIndex}>{item.desc}</Text>
          </AutocompleteItem>
        );
      })}
      {showScrollDown ? (
        <Text dimColor>
          {"  "}↓ {totalMatches - startIndex - VISIBLE_COMMANDS} more below
        </Text>
      ) : needsScrolling ? (
        <Text> </Text>
      ) : null}
    </AutocompleteBox>
  );
}
