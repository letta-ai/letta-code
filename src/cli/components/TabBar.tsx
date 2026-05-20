// Shared tab bar for overlay selectors.
// Renders a row of tabs with the active one highlighted.
// Does NOT own tab state or handle input — the parent controls activeTab.

import { Box } from "ink";
import { colors } from "./colors";
import { Text } from "./Text";

export interface TabBarProps<T extends string> {
  tabs: T[];
  activeTab: T;
  getLabel: (tab: T) => string;
}

export function TabBar<T extends string>({
  tabs,
  activeTab,
  getLabel,
}: TabBarProps<T>) {
  return (
    <Box flexDirection="row" gap={2}>
      {tabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <Text
            key={tab}
            backgroundColor={
              isActive ? colors.selector.itemHighlighted : undefined
            }
            color={isActive ? "white" : undefined}
            bold={isActive}
          >
            {` ${getLabel(tab)} `}
          </Text>
        );
      })}
    </Box>
  );
}
