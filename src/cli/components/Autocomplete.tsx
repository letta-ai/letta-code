import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

interface AutocompleteBoxProps {
  header?: ReactNode;
  children: ReactNode;
}

export function AutocompleteBox({ header, children }: AutocompleteBoxProps) {
  return (
    <Box flexDirection="column">
      {header && <Text dimColor>{header}</Text>}
      {children}
    </Box>
  );
}

interface AutocompleteItemProps {
  selected: boolean;
  children: ReactNode;
}

export function AutocompleteItem({
  selected,
  children,
}: AutocompleteItemProps) {
  return (
    <Text
      color={selected ? colors.command.selected : undefined}
      bold={selected}
      wrap="truncate-end"
    >
      {"  "}
      {children}
    </Text>
  );
}
