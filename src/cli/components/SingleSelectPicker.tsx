// Reusable single-select vertical list picker.
//
// Renders a vertical list with cursor navigation (↑↓),
// Enter to confirm, Escape to cancel.
// Items are identified by key (string), not index.

import { Box, type Key, useInput } from "ink";
import { memo, useCallback, useEffect, useState } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

export interface SelectableItem {
  key: string;
  label: string;
  description?: string;
  /** When true, shows "(current)" marker and uses `colors.selector.itemCurrent` */
  isCurrent?: boolean;
  /** When true, item is dimmed and Enter is a no-op */
  disabled?: boolean;
  /** When true, label renders dimmed but item is still selectable */
  dimLabel?: boolean;
}

export interface SingleSelectPickerProps {
  items: SelectableItem[];
  /** Start cursor at this index (default 0) */
  initialCursorIndex?: number;
  /** Called when user presses Enter on an item */
  onSelect: (key: string) => void;
  /** Called when user presses Escape or Ctrl-C */
  onCancel: () => void;
}

export const SingleSelectPicker = memo(function SingleSelectPicker({
  items,
  initialCursorIndex = 0,
  onSelect,
  onCancel,
}: SingleSelectPickerProps) {
  const [cursor, setCursor] = useState(initialCursorIndex);

  // Clamp cursor when items change
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
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
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
    },
    [items, cursor, onCancel, onSelect],
  );

  useInput(handleInput, { isActive: true });

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isCursor = index === cursor;
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

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor> Enter select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
});
