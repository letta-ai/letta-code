import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { colors } from "./colors";
import { searchFiles } from "../helpers/fileSearch";

interface FileMatch {
  path: string;
  type: "file" | "dir" | "url";
}

interface FileAutocompleteProps {
  currentInput: string;
  cursorPosition?: number;
  onSelect?: (path: string) => void;
  onActiveChange?: (isActive: boolean) => void;
}

export function FileAutocomplete({
  currentInput,
  cursorPosition = currentInput.length,
  onSelect,
  onActiveChange,
}: FileAutocompleteProps) {
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lastValidQuery, setLastValidQuery] = useState<string>("");

  // Extract the text after the "@" symbol where the cursor is positioned
  const extractSearchQuery = (
    input: string,
    cursor: number,
  ): { query: string; hasSpaceAfter: boolean; atIndex: number } | null => {
    // Find all @ positions
    const atPositions: number[] = [];
    for (let i = 0; i < input.length; i++) {
      if (input[i] === "@") {
        // Only count @ at start or after space
        if (i === 0 || input[i - 1] === " ") {
          atPositions.push(i);
        }
      }
    }

    if (atPositions.length === 0) return null;

    // Find which @ the cursor is in
    let atIndex = -1;
    for (const pos of atPositions) {
      // Find the end of this @reference (next space or end of string)
      const afterAt = input.slice(pos + 1);
      const spaceIndex = afterAt.indexOf(" ");
      const endPos = spaceIndex === -1 ? input.length : pos + 1 + spaceIndex;

      // Check if cursor is within this @reference
      if (cursor >= pos && cursor <= endPos) {
        atIndex = pos;
        break;
      }
    }

    // If cursor is not in any @reference, don't show autocomplete
    if (atIndex === -1) return null;

    // Get text after "@" until next space or end
    const afterAt = input.slice(atIndex + 1);
    const spaceIndex = afterAt.indexOf(" ");
    const query = spaceIndex === -1 ? afterAt : afterAt.slice(0, spaceIndex);
    const hasSpaceAfter = spaceIndex !== -1;

    return { query, hasSpaceAfter, atIndex };
  };

  // Handle keyboard navigation
  useInput((input, key) => {
    if (!matches.length || isLoading) return;

    const maxIndex = Math.min(matches.length, 10) - 1;

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
    } else if ((key.tab || key.return) && onSelect) {
      // Insert selected file path on Tab or Enter
      const selected = matches[selectedIndex];
      if (selected) {
        onSelect(selected.path);
      }
    }
  });

  useEffect(() => {
    const result = extractSearchQuery(currentInput, cursorPosition);

    if (!result) {
      setMatches([]);
      setSelectedIndex(0);
      onActiveChange?.(false);
      return;
    }

    const { query, hasSpaceAfter } = result;

    // If there's text after the space, user has moved on - hide autocomplete
    // But keep it open if there's just a trailing space (allows editing the path)
    if (hasSpaceAfter && query.length > 0) {
      const atIndex = currentInput.lastIndexOf("@");
      const afterSpace = currentInput.slice(atIndex + 1 + query.length + 1);

      // Always hide if there's more non-whitespace content after, or another @
      if (afterSpace.trim().length > 0 || afterSpace.includes("@")) {
        setMatches([]);
        setSelectedIndex(0);
        onActiveChange?.(false);
        return;
      }

      // Just a trailing space - check if this query had valid matches when selected
      // Use lastValidQuery to remember what was successfully selected
      if (query === lastValidQuery && lastValidQuery.length > 0) {
        // Show the selected file (non-interactive)
        if (matches[0]?.path !== query) {
          setMatches([{ path: query, type: "file" }]);
          setSelectedIndex(0);
        }
        onActiveChange?.(false); // Don't block Enter key
        return;
      }

      // No valid selection was made, hide
      setMatches([]);
      setSelectedIndex(0);
      onActiveChange?.(false);
      return;
    }

    // If query is empty (just typed "@"), show current directory contents
    if (query.length === 0) {
      setIsLoading(true);
      onActiveChange?.(true);
      searchFiles("", false) // Don't do deep search for empty query
        .then((results) => {
          setMatches(results);
          setSelectedIndex(0);
          setIsLoading(false);
          onActiveChange?.(results.length > 0);
        })
        .catch(() => {
          setMatches([]);
          setSelectedIndex(0);
          setIsLoading(false);
          onActiveChange?.(false);
        });
      return;
    }

    // Check if it's a URL pattern
    if (query.startsWith("http://") || query.startsWith("https://")) {
      setMatches([{ path: query, type: "url" }]);
      setSelectedIndex(0);
      onActiveChange?.(true);
      return;
    }

    // Search for matching files (deep search through subdirectories)
    setIsLoading(true);
    onActiveChange?.(true);
    searchFiles(query, true) // Enable deep search
      .then((results) => {
        setMatches(results);
        setSelectedIndex(0);
        setIsLoading(false);
        onActiveChange?.(results.length > 0);
        // Remember this query had valid matches
        if (results.length > 0) {
          setLastValidQuery(query);
        }
      })
      .catch(() => {
        setMatches([]);
        setSelectedIndex(0);
        setIsLoading(false);
        onActiveChange?.(false);
      });
  }, [currentInput, cursorPosition, onActiveChange]);

  // Don't show if no "@" in input
  if (!currentInput.includes("@")) {
    return null;
  }

  // Don't show if no matches and not loading
  if (matches.length === 0 && !isLoading) {
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
        File/URL autocomplete (↑↓ to navigate, Tab/Enter to select):
      </Text>
      {isLoading ? (
        <Text dimColor>Searching...</Text>
      ) : (
        matches.slice(0, 10).map((item, idx) => (
          <Box key={idx} flexDirection="row" gap={1}>
            <Text
              color={
                idx === selectedIndex
                  ? colors.status.success
                  : item.type === "dir"
                    ? colors.status.processing
                    : undefined
              }
              bold={idx === selectedIndex}
            >
              {idx === selectedIndex ? "▶ " : "  "}
              {item.type === "dir" ? "📁" : item.type === "url" ? "🔗" : "📄"}
            </Text>
            <Text bold={idx === selectedIndex}>{item.path}</Text>
          </Box>
        ))
      )}
      {matches.length > 10 && (
        <Text dimColor>... and {matches.length - 10} more</Text>
      )}
    </Box>
  );
}
