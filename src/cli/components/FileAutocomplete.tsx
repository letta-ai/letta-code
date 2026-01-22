import { Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { searchFiles } from "../helpers/fileSearch";
import { useAutocompleteNavigation } from "../hooks/useAutocompleteNavigation";
import { AutocompleteBox, AutocompleteItem } from "./Autocomplete";
import { colors } from "./colors";
import type { AutocompleteProps, FileMatch } from "./types/autocomplete";

// Extract the text after the "@" symbol where the cursor is positioned
function extractSearchQuery(
  input: string,
  cursor: number,
): { query: string; hasSpaceAfter: boolean; atIndex: number } | null {
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
}

export function FileAutocomplete({
  currentInput,
  cursorPosition = currentInput.length,
  onSelect,
  onActiveChange,
}: AutocompleteProps) {
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastValidQuery, setLastValidQuery] = useState<string>("");
  const debounceTimeout = useRef<NodeJS.Timeout | null>(null);

  // Use shared navigation hook (with manual active state management due to async loading)
  const { selectedIndex } = useAutocompleteNavigation({
    matches,
    maxVisible: 10,
    onSelect: onSelect ? (item) => onSelect(item.path) : undefined,
    manageActiveState: false, // We manage active state manually due to async loading
  });

  useEffect(() => {
    // Clear any existing debounce timeout
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }

    const result = extractSearchQuery(currentInput, cursorPosition);

    if (!result) {
      setMatches([]);
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
        onActiveChange?.(false);
        return;
      }

      // Just a trailing space - check if this query had valid matches when selected
      // Use lastValidQuery to remember what was successfully selected
      if (query === lastValidQuery && lastValidQuery.length > 0) {
        // Show the selected file (non-interactive)
        if (matches[0]?.path !== query) {
          setMatches([{ path: query, type: "file" }]);
        }
        onActiveChange?.(false); // Don't block Enter key
        return;
      }

      // No valid selection was made, hide
      setMatches([]);
      onActiveChange?.(false);
      return;
    }

    // If query is empty (just typed "@"), show current directory contents (no debounce)
    if (query.length === 0) {
      setIsLoading(true);
      onActiveChange?.(true);
      searchFiles("", false) // Don't do deep search for empty query
        .then((results) => {
          setMatches(results);
          setIsLoading(false);
          onActiveChange?.(results.length > 0);
        })
        .catch(() => {
          setMatches([]);
          setIsLoading(false);
          onActiveChange?.(false);
        });
      return;
    }

    // Check if it's a URL pattern (no debounce)
    if (query.startsWith("http://") || query.startsWith("https://")) {
      setMatches([{ path: query, type: "url" }]);
      onActiveChange?.(true);
      return;
    }

    // Debounce the file search (300ms delay)
    // Keep existing matches visible while debouncing
    setIsLoading(true);
    onActiveChange?.(true);

    debounceTimeout.current = setTimeout(() => {
      // Search for matching files (deep search through subdirectories)
      searchFiles(query, true) // Enable deep search
        .then((results) => {
          setMatches(results);
          setIsLoading(false);
          onActiveChange?.(results.length > 0);
          // Remember this query had valid matches
          if (results.length > 0) {
            setLastValidQuery(query);
          }
        })
        .catch(() => {
          setMatches([]);
          setIsLoading(false);
          onActiveChange?.(false);
        });
    }, 300);

    // Cleanup function to clear timeout on unmount
    return () => {
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current);
      }
    };
  }, [
    currentInput,
    cursorPosition,
    onActiveChange,
    lastValidQuery,
    matches[0]?.path,
  ]);

  // Don't show if no "@" in input
  if (!currentInput.includes("@")) {
    return null;
  }

  // Don't show if no matches and not loading
  if (matches.length === 0 && !isLoading) {
    return null;
  }

  const header = (
    <>
      File/URL autocomplete (↑↓ navigate, Tab/Enter select):
      {isLoading && " Searching..."}
    </>
  );

  return (
    <AutocompleteBox header={header}>
      {matches.length > 0 ? (
        <>
          {matches.slice(0, 10).map((item, idx) => (
            <AutocompleteItem key={item.path} selected={idx === selectedIndex}>
              <Text
                color={
                  idx !== selectedIndex && item.type === "dir"
                    ? colors.status.processing
                    : undefined
                }
              >
                {item.type === "dir" ? "📁" : item.type === "url" ? "🔗" : "📄"}
              </Text>{" "}
              {item.path}
            </AutocompleteItem>
          ))}
          {matches.length > 10 && (
            <Text dimColor>... and {matches.length - 10} more</Text>
          )}
        </>
      ) : (
        isLoading && <Text dimColor>Searching...</Text>
      )}
    </AutocompleteBox>
  );
}
