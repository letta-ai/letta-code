import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { colors } from "./colors";

interface AutocompleteBoxProps {
  /** Header text shown at top of autocomplete */
  header: ReactNode;
  children: ReactNode;
}

/**
 * Shared container for autocomplete dropdowns.
 * Provides consistent styling for both file and command autocomplete.
 */
export function AutocompleteBox({ header, children }: AutocompleteBoxProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.command.border}
      paddingX={1}
      marginBottom={1}
    >
      <Text dimColor>{header}</Text>
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
 * Handles selection indicator and styling.
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
      {selected ? "▶ " : "  "}
      {children}
    </Text>
  );
}
