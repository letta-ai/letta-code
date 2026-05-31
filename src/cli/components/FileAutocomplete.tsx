import { useEffect, useRef, useState } from "react";
import {
  type FileAutocompleteMatch,
  searchFileAutocomplete,
} from "@/cli/helpers/file-autocomplete-search";
import { useAutocompleteNavigation } from "@/cli/hooks/use-autocomplete-navigation";
import { AutocompleteBox, AutocompleteItem } from "./Autocomplete";
import { colors } from "./colors";
import { Text } from "./Text";
import type { AutocompleteProps } from "./types/autocomplete";

function extractSearchQuery(
  input: string,
  cursor: number,
): { query: string; hasSpaceAfter: boolean; atIndex: number } | null {
  const atPositions: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== "@") continue;
    if (i === 0 || input[i - 1] === " ") {
      atPositions.push(i);
    }
  }

  for (const atIndex of atPositions) {
    const afterAt = input.slice(atIndex + 1);
    const spaceIndex = afterAt.indexOf(" ");
    const endPos = spaceIndex === -1 ? input.length : atIndex + 1 + spaceIndex;

    if (cursor >= atIndex && cursor <= endPos) {
      return {
        query: spaceIndex === -1 ? afterAt : afterAt.slice(0, spaceIndex),
        hasSpaceAfter: spaceIndex !== -1,
        atIndex,
      };
    }
  }

  return null;
}

function isUrlQuery(query: string): boolean {
  return query.startsWith("http://") || query.startsWith("https://");
}

export function FileAutocomplete({
  currentInput,
  cursorPosition = currentInput.length,
  onSelect,
  onAutocomplete,
  onActiveChange,
  workingDirectory,
}: AutocompleteProps) {
  const [matches, setMatches] = useState<FileAutocompleteMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchGenRef = useRef(0);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const { selectedIndex } = useAutocompleteNavigation({
    matches,
    maxVisible: 10,
    onSelect: onSelect ? (item) => onSelect(item.path) : undefined,
    onAutocomplete: onAutocomplete
      ? (item) => onAutocomplete(item.path)
      : onSelect
        ? (item) => onSelect(item.path)
        : undefined,
    manageActiveState: false,
  });

  useEffect(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    abortControllerRef.current?.abort();

    const result = extractSearchQuery(currentInput, cursorPosition);
    if (!result || (result.hasSpaceAfter && result.query.length > 0)) {
      searchGenRef.current++;
      setMatches([]);
      setIsLoading(false);
      onActiveChange?.(false);
      return;
    }

    const { query } = result;
    const gen = ++searchGenRef.current;

    if (isUrlQuery(query)) {
      setMatches([{ path: query, type: "url" }]);
      setIsLoading(false);
      onActiveChange?.(true);
      return;
    }

    const runSearch = () => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setIsLoading(true);
      onActiveChange?.(true);

      searchFileAutocomplete(query, {
        cwd: workingDirectory,
        signal: controller.signal,
      })
        .then((results) => {
          if (searchGenRef.current !== gen) return;
          setMatches(results);
          setIsLoading(false);
          onActiveChange?.(results.length > 0);
        })
        .catch(() => {
          if (searchGenRef.current !== gen) return;
          setMatches([]);
          setIsLoading(false);
          onActiveChange?.(false);
        });
    };

    if (query.length === 0) {
      runSearch();
    } else {
      setIsLoading(true);
      onActiveChange?.(true);
      debounceTimeoutRef.current = setTimeout(runSearch, 150);
    }

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }
      abortControllerRef.current?.abort();
    };
  }, [currentInput, cursorPosition, onActiveChange, workingDirectory]);

  if (!currentInput.includes("@")) return null;
  if (matches.length === 0 && !isLoading) return null;

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
            <AutocompleteItem
              key={`${item.type}:${item.path}`}
              selected={idx === selectedIndex}
            >
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
