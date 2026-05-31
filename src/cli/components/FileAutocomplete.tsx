import { useEffect, useRef, useState } from "react";
import {
  applyPiFileCompletion,
  type FileAutocompleteItem,
  FileAutocompleteProvider,
  type FileAutocompleteSuggestions,
} from "@/cli/helpers/file-autocomplete";
import { useAutocompleteNavigation } from "@/cli/hooks/use-autocomplete-navigation";
import { AutocompleteBox, AutocompleteItem } from "./Autocomplete";
import { colors } from "./colors";
import { Text } from "./Text";

interface FileAutocompleteProps {
  currentInput: string;
  cursorPosition: number;
  fdPath?: string | null;
  workingDirectory?: string;
  onApplyCompletion: (value: string, cursorPosition: number) => void;
  onActiveChange?: (isActive: boolean) => void;
}

function isDirectoryItem(item: FileAutocompleteItem): boolean {
  return item.label.endsWith("/");
}

export function FileAutocomplete({
  currentInput,
  cursorPosition,
  fdPath,
  workingDirectory,
  onApplyCompletion,
  onActiveChange,
}: FileAutocompleteProps) {
  const [suggestions, setSuggestions] =
    useState<FileAutocompleteSuggestions | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const searchGenRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const matches = suggestions?.items ?? [];

  const applyItem = (item: FileAutocompleteItem) => {
    if (!suggestions) return;
    const result = applyPiFileCompletion(
      currentInput,
      cursorPosition,
      item,
      suggestions.prefix,
    );
    onApplyCompletion(result.value, result.cursorPosition);
  };

  const { selectedIndex } = useAutocompleteNavigation({
    matches,
    maxVisible: 10,
    onSelect: applyItem,
    onAutocomplete: applyItem,
    manageActiveState: false,
  });

  useEffect(() => {
    if (!currentInput.includes("@")) {
      abortControllerRef.current?.abort();
      setSuggestions(null);
      setIsLoading(false);
      return;
    }

    abortControllerRef.current?.abort();
    const gen = ++searchGenRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsLoading(true);
    onActiveChange?.(true);

    async function search() {
      if (!fdPath) {
        setSuggestions(null);
        setIsLoading(false);
        onActiveChange?.(false);
        return;
      }

      const provider = new FileAutocompleteProvider(
        workingDirectory ?? process.cwd(),
        fdPath,
      );
      const nextSuggestions = await provider.getSuggestions(
        currentInput,
        cursorPosition,
        {
          signal: controller.signal,
        },
      );

      if (searchGenRef.current !== gen || controller.signal.aborted) return;

      setSuggestions(nextSuggestions);
      setIsLoading(false);
      onActiveChange?.((nextSuggestions?.items.length ?? 0) > 0);
    }

    search().catch(() => {
      if (searchGenRef.current !== gen) return;
      setSuggestions(null);
      setIsLoading(false);
      onActiveChange?.(false);
    });

    return () => {
      controller.abort();
    };
  }, [currentInput, cursorPosition, fdPath, onActiveChange, workingDirectory]);

  if (!currentInput.includes("@")) return null;
  if (matches.length === 0 && !isLoading) return null;

  const header = (
    <>
      File autocomplete (↑↓ navigate, Tab/Enter select):
      {isLoading && " Searching..."}
    </>
  );

  return (
    <AutocompleteBox header={header}>
      {matches.length > 0 ? (
        <>
          {matches.slice(0, 10).map((item, idx) => (
            <AutocompleteItem
              key={`${item.value}:${item.description ?? ""}`}
              selected={idx === selectedIndex}
            >
              <Text
                color={
                  idx !== selectedIndex && isDirectoryItem(item)
                    ? colors.status.processing
                    : undefined
                }
              >
                {isDirectoryItem(item) ? "📁" : "📄"}
              </Text>{" "}
              {item.label}
              {item.description && item.description !== item.label && (
                <Text dimColor> {item.description}</Text>
              )}
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
