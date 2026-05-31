import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyPiFileCompletion,
  type PiAutocompleteItem,
  type PiAutocompleteSuggestions,
  PiFileAutocompleteProvider,
  resolveFdPath,
} from "@/cli/helpers/pi-file-autocomplete";
import { useAutocompleteNavigation } from "@/cli/hooks/use-autocomplete-navigation";
import { AutocompleteBox, AutocompleteItem } from "./Autocomplete";
import { colors } from "./colors";
import { Text } from "./Text";

interface FileAutocompleteProps {
  currentInput: string;
  cursorPosition: number;
  workingDirectory?: string;
  onApplyCompletion: (value: string, cursorPosition: number) => void;
  onActiveChange?: (isActive: boolean) => void;
}

const fdPath = resolveFdPath();

function isDirectoryItem(item: PiAutocompleteItem): boolean {
  return item.label.endsWith("/");
}

export function FileAutocomplete({
  currentInput,
  cursorPosition,
  workingDirectory,
  onApplyCompletion,
  onActiveChange,
}: FileAutocompleteProps) {
  const [suggestions, setSuggestions] =
    useState<PiAutocompleteSuggestions | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const searchGenRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const provider = useMemo(
    () =>
      new PiFileAutocompleteProvider(workingDirectory ?? process.cwd(), fdPath),
    [workingDirectory],
  );
  const matches = suggestions?.items ?? [];

  const applyItem = (item: PiAutocompleteItem) => {
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
    abortControllerRef.current?.abort();
    const gen = ++searchGenRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsLoading(true);
    onActiveChange?.(true);

    provider
      .getSuggestions(currentInput, cursorPosition, {
        signal: controller.signal,
      })
      .then((nextSuggestions) => {
        if (searchGenRef.current !== gen) return;
        setSuggestions(nextSuggestions);
        setIsLoading(false);
        onActiveChange?.((nextSuggestions?.items.length ?? 0) > 0);
      })
      .catch(() => {
        if (searchGenRef.current !== gen) return;
        setSuggestions(null);
        setIsLoading(false);
        onActiveChange?.(false);
      });

    return () => {
      controller.abort();
    };
  }, [currentInput, cursorPosition, onActiveChange, provider]);

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
