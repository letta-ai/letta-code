import { Box, type Key, useInput } from "ink";
import { memo, type ReactNode, useCallback, useEffect, useState } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

export interface SelectableItem {
  key: string;
  label: string;
  description?: string;
  isCurrent?: boolean;
  disabled?: boolean;
  dimLabel?: boolean;
}

export interface SingleSelectPickerProps {
  items: SelectableItem[];
  initialCursorIndex?: number;
  onSelect: (key: string) => void;
  onCancel: () => void;
  renderItem?: (
    item: SelectableItem,
    index: number,
    isSelected: boolean,
  ) => ReactNode;
  onUnhandledKey?: (input: string, key: Key) => void;
  footer?: ReactNode;
}

export const SingleSelectPicker = memo(function SingleSelectPicker({
  items,
  initialCursorIndex = 0,
  onSelect,
  onCancel,
  renderItem,
  onUnhandledKey,
  footer,
}: SingleSelectPickerProps) {
  const [cursor, setCursor] = useState(initialCursorIndex);

  useEffect(() => {
    if (items.length === 0) return;
    setCursor((c) => Math.min(c, items.length - 1));
  }, [items.length]);

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((c) => Math.min(items.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const item = items[cursor];
        if (item && !item.disabled) {
          onSelect(item.key);
        }
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (onUnhandledKey) {
        onUnhandledKey(input, key);
      }
    },
    [items, cursor, onCancel, onSelect, onUnhandledKey],
  );

  useInput(handleInput, { isActive: true });

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isCursor = index === cursor;

        if (renderItem) {
          return <Box key={item.key}>{renderItem(item, index, isCursor)}</Box>;
        }

        const isCurrent = item.isCurrent ?? false;
        const isDisabled = item.disabled ?? false;
        const isDimLabel = item.dimLabel ?? false;

        const cursorColor = isDisabled
          ? undefined
          : isCursor
            ? colors.selector.itemHighlighted
            : undefined;
        const labelColor = isDisabled
          ? undefined
          : isCursor
            ? colors.selector.itemHighlighted
            : isCurrent
              ? colors.selector.itemCurrent
              : undefined;

        return (
          <Box key={item.key} flexDirection="row">
            <Text color={cursorColor}>{isCursor ? "> " : "  "}</Text>
            <Text
              color={labelColor}
              bold={isCursor && !isDisabled}
              dimColor={isDisabled || isDimLabel}
            >
              {item.label}
              {isCurrent && " (current)"}
            </Text>
            {item.description && (
              <Text dimColor>{` · ${item.description}`}</Text>
            )}
          </Box>
        );
      })}

      <Box marginTop={footer ? 0 : 1}>
        {footer ?? (
          <Text dimColor> Enter select · ↑↓/jk navigate · Esc cancel</Text>
        )}
      </Box>
    </Box>
  );
});
