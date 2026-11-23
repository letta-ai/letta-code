import { useInput } from "ink";
import { useEffect, useRef, useState } from "react";

interface UseAutocompleteNavigationOptions<T> {
  matches: T[];
  maxVisible?: number;
  onSelect?: (item: T) => void;
  onAutocomplete?: (item: T) => void;
  onActiveChange?: (isActive: boolean) => void;
  manageActiveState?: boolean;
  disabled?: boolean;
}

interface UseAutocompleteNavigationResult {
  selectedIndex: number;
}

export function useAutocompleteNavigation<T>({
  matches,
  maxVisible,
  onSelect,
  onAutocomplete,
  onActiveChange,
  manageActiveState = true,
  disabled = false,
}: UseAutocompleteNavigationOptions<T>): UseAutocompleteNavigationResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevMatchCountRef = useRef(0);
  const prevIsActiveRef = useRef(false);

  useEffect(() => {
    if (matches.length !== prevMatchCountRef.current) {
      setSelectedIndex(0);
      prevMatchCountRef.current = matches.length;
    }
  }, [matches.length]);

  useEffect(() => {
    if (manageActiveState) {
      const isActive = matches.length > 0;
      if (isActive !== prevIsActiveRef.current) {
        prevIsActiveRef.current = isActive;
        onActiveChange?.(isActive);
      }
    }
  }, [matches.length, onActiveChange, manageActiveState]);

  useInput((_input, key) => {
    if (!matches.length || disabled) return;

    const maxIndex =
      maxVisible !== undefined
        ? Math.min(matches.length, maxVisible) - 1
        : matches.length - 1;

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
    } else if (key.tab) {
      const selected = matches[selectedIndex];
      if (selected) {
        if (onAutocomplete) {
          onAutocomplete(selected);
        } else if (onSelect) {
          onSelect(selected);
        }
      }
    } else if (key.return && onSelect) {
      const selected = matches[selectedIndex];
      if (selected) {
        onSelect(selected);
      }
    }
  });

  return { selectedIndex };
}
