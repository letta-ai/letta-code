import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

interface AutocompleteBoxProps {
  /** Optional header text shown at top of autocomplete */
  header?: ReactNode;
  children: ReactNode;
}

/**
 * Shared container for autocomplete dropdowns.
 * Provides consistent styling for both file and command autocomplete.
 */
export function AutocompleteBox({ header, children }: AutocompleteBoxProps) {
  return (
    <Box flexDirection="column">
      {header && <Text dimColor>{header}</Text>}
      {children}
    </Box>
  );
}

interface AutocompleteItemProps {
  /** Whether this item is currently selected */
  selected: boolean;
  /** Unique key for React */
  children: ReactNode;
}

/**
 * Shared item component for autocomplete lists.
 * Handles selection styling (color-based, no arrow indicator).
 * 2-char gutter aligns with input box prompt.
 */
export function AutocompleteItem({
  selected,
  children,
}: AutocompleteItemProps) {
  return (
    <Text
      color={selected ? colors.command.selected : undefined}
      bold={selected}
    >
      {"  "}
      {children}
    </Text>
  );
}
