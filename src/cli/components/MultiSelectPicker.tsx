// Reusable multi-select checkbox picker for interactive configuration.
//
// Pure list + input handling. Wrappers provide the shell
// (header, title, footer) via OverlayShell.
//
// - No custom input / "Type something" option
// - No "Submit" button — Enter confirms directly
// - Optional live preview line at the bottom
// - Items are identified by key (string), not index

import { Box, type Key, useInput } from "ink";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { colors } from "./colors";
import { Text } from "./Text";

export interface SelectableItem {
  key: string;
  label: string;
  description: string;
  /** When true, Space does not toggle this item and it renders dimmed. */
  disabled?: boolean;
}

export interface MultiSelectPickerProps {
  items: SelectableItem[];
  selected: Set<string>;
  onConfirm: (selectedKeys: string[]) => void;
  onCancel: () => void;
  onSelectionChange?: (selectedKeys: string[]) => void;
  preview?: string;
  enableOrdering?: boolean;
}

export const MultiSelectPicker = memo(function MultiSelectPicker({
  items,
  selected,
  onConfirm,
  onCancel,
  onSelectionChange,
  preview,
  enableOrdering = false,
}: MultiSelectPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [orderedItems, setOrderedItems] = useState<SelectableItem[]>(items);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(
    () => new Set(selected),
  );
  const columns = useTerminalWidth();

  useEffect(() => {
    setOrderedItems(items);
    setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
  }, [items]);

  const selectedKeysInOrder = useMemo(
    () =>
      orderedItems
        .filter((item) => selectedSet.has(item.key))
        .map((item) => item.key),
    [orderedItems, selectedSet],
  );

  const toggle = useCallback((key: string) => {
    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const moveSelectedItem = useCallback(
    (direction: "up" | "down") => {
      if (!enableOrdering) return;
      const nextIndex = direction === "up" ? cursor - 1 : cursor + 1;
      setOrderedItems((prev) => {
        if (cursor < 0 || cursor >= prev.length) return prev;
        if (nextIndex < 0 || nextIndex >= prev.length) return prev;

        const next = [...prev];
        const current = next[cursor];
        const target = next[nextIndex];
        if (!current || !target) return prev;
        next[cursor] = target;
        next[nextIndex] = current;
        return next;
      });
      if (nextIndex >= 0 && nextIndex < orderedItems.length) {
        setCursor(nextIndex);
      }
    },
    [cursor, enableOrdering, orderedItems.length],
  );

  // Propagate selection/order changes to parent in a separate render cycle
  useEffect(() => {
    onSelectionChange?.(selectedKeysInOrder);
  }, [selectedKeysInOrder, onSelectionChange]);

  const handleInput = useCallback(
    (input: string, key: Key) => {
      // Up: arrow or vim-style "k"
      if (key.upArrow || input === "k") {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      // Down: arrow or vim-style "j"
      if (key.downArrow || input === "j") {
        setCursor((c) => Math.min(orderedItems.length - 1, c + 1));
        return;
      }
      if (enableOrdering && key.leftArrow) {
        moveSelectedItem("up");
        return;
      }
      if (enableOrdering && key.rightArrow) {
        moveSelectedItem("down");
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        onConfirm(selectedKeysInOrder);
        return;
      }
      // Space toggles checkbox (no-op for disabled items)
      if (input === " ") {
        const item = orderedItems[cursor];
        if (item && !item.disabled) {
          toggle(item.key);
        }
        return;
      }
    },
    [
      cursor,
      enableOrdering,
      moveSelectedItem,
      onCancel,
      onConfirm,
      orderedItems,
      selectedKeysInOrder,
      toggle,
    ],
  );

  useInput(handleInput, { isActive: true });

  return (
    <Box flexDirection="column">
      {/* Items */}
      <Box flexDirection="column">
        {orderedItems.map((item, index) => {
          const isCursor = index === cursor;
          const isChecked = selectedSet.has(item.key);
          const isDisabled = item.disabled ?? false;
          const color = isDisabled
            ? undefined
            : isCursor
              ? colors.approval.header
              : undefined;

          return (
            <Box key={item.key} flexDirection="row">
              {/* Cursor indicator */}
              <Box width={2} flexShrink={0}>
                <Text color={color}>{isCursor ? "›" : " "}</Text>
              </Box>
              {/* Checkbox */}
              <Box width={4} flexShrink={0}>
                <Text
                  color={isDisabled ? undefined : isChecked ? "green" : color}
                  dimColor={isDisabled}
                >
                  [{isChecked ? "✓" : " "}]{" "}
                </Text>
              </Box>
              {/* Label + description */}
              <Box flexGrow={1} width={Math.max(0, columns - 6)}>
                <Text
                  color={color}
                  bold={isCursor && !isDisabled}
                  dimColor={isDisabled}
                  wrap="truncate-end"
                >
                  {item.label}
                  {item.description && (
                    <Text dimColor> · {item.description}</Text>
                  )}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Preview */}
      {preview !== undefined && (
        <>
          <Box height={1} />
          <Text bold>{preview}</Text>
        </>
      )}

      {/* Hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Space to toggle · ↑↓ to navigate · Enter to confirm · Esc to cancel
          {enableOrdering ? " · ←→ to reorder" : ""}
        </Text>
      </Box>
    </Box>
  );
});
