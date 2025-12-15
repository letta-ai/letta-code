import { useInput } from "ink";
import { useEffect, useRef, useState } from "react";

interface UseAutocompleteNavigationOptions<T> {
  /** Array of items to navigate through */
  matches: T[];
  /** Maximum number of visible items (for wrapping navigation) */
  maxVisible?: number;
  /** Callback when an item is selected via Tab or Enter */
  onSelect?: (item: T) => void;
  /** Callback when active state changes (has matches or not) */
  onActiveChange?: (isActive: boolean) => void;
  /** Skip automatic active state management (for components with async loading) */
  manageActiveState?: boolean;
  /** Whether navigation is currently disabled (e.g., during loading) */
  disabled?: boolean;
}

interface UseAutocompleteNavigationResult {
  /** Currently selected index */
  selectedIndex: number;
  /** Reset the selected index (e.g., when matches change) */
  resetSelection: () => void;
}

/**
 * Shared hook for autocomplete keyboard navigation.
 * Handles up/down arrow keys for selection and Tab/Enter for confirmation.
 */
export function useAutocompleteNavigation<T>({
  matches,
  maxVisible = 10,
  onSelect,
  onActiveChange,
  manageActiveState = true,
  disabled = false,
}: UseAutocompleteNavigationOptions<T>): UseAutocompleteNavigationResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevMatchCountRef = useRef(0);

  // Reset selected index when matches change significantly
  useEffect(() => {
    if (matches.length !== prevMatchCountRef.current) {
      setSelectedIndex(0);
      prevMatchCountRef.current = matches.length;
    }
  }, [matches.length]);

  // Notify parent about active state changes (only if manageActiveState is true)
  useEffect(() => {
    if (manageActiveState) {
      onActiveChange?.(matches.length > 0);
    }
  }, [matches.length, onActiveChange, manageActiveState]);

  // Handle keyboard navigation
  useInput((_input, key) => {
    if (!matches.length || disabled) return;

    const maxIndex = Math.min(matches.length, maxVisible) - 1;

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
    } else if ((key.tab || key.return) && onSelect) {
      const selected = matches[selectedIndex];
      if (selected) {
        onSelect(selected);
      }
    }
  });

  const resetSelection = () => setSelectedIndex(0);

  return {
    selectedIndex,
    resetSelection,
  };
}
