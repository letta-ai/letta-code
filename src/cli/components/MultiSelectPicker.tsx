// Reusable multi-select checkbox picker for interactive configuration.
//
// Inspired by Codex's "Configure Terminal Title" UI and extracted from
// InlineQuestionApproval's multi-select logic, but simplified:
// - No custom input / "Type something" option
// - No "Submit" button — Enter confirms directly
// - Optional live preview line at the bottom
// - Items are identified by key (string), not index

import { Box, type Key, useInput } from "ink";
import { memo, useCallback, useEffect, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

export interface SelectableItem {
  key: string;
  label: string;
  description: string;
}

export interface MultiSelectPickerProps {
  title: string;
  description: string;
  items: SelectableItem[];
  selected: Set<string>;
  onConfirm: (selectedKeys: string[]) => void;
  onCancel: () => void;
  onSelectionChange?: (selectedKeys: string[]) => void;
  preview?: string;
}

export const MultiSelectPicker = memo(function MultiSelectPicker({
  title,
  description,
  items,
  selected,
  onConfirm,
  onCancel,
  onSelectionChange,
  preview,
}: MultiSelectPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(
    () => new Set(selected),
  );
  const columns = useTerminalWidth();

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

  // Propagate selection changes to parent in a separate render cycle
  useEffect(() => {
    onSelectionChange?.([...selectedSet]);
  }, [selectedSet, onSelectionChange]);

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(items.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        onConfirm([...selectedSet]);
        return;
      }
      // Space toggles checkbox
      if (input === " ") {
        const item = items[cursor];
        if (item) {
          toggle(item.key);
        }
        return;
      }
    },
    [items, cursor, onCancel, onConfirm, selectedSet, toggle],
  );

  useInput(handleInput, { isActive: true });

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Text bold>{title}</Text>

      {/* Description */}
      <Text dimColor>{description}</Text>

      <Box height={1} />

      {/* Items */}
      <Box flexDirection="column">
        {items.map((item, index) => {
          const isCursor = index === cursor;
          const isChecked = selectedSet.has(item.key);
          const color = isCursor ? colors.approval.header : undefined;

          return (
            <Box key={item.key} flexDirection="row">
              {/* Cursor indicator */}
              <Box width={2} flexShrink={0}>
                <Text color={color}>{isCursor ? "›" : " "}</Text>
              </Box>
              {/* Checkbox */}
              <Box width={4} flexShrink={0}>
                <Text color={isChecked ? "green" : color}>
                  [{isChecked ? "✓" : " "}]{" "}
                </Text>
              </Box>
              {/* Label + description */}
              <Box flexGrow={1} width={Math.max(0, columns - 6)}>
                <Text color={color} bold={isCursor} wrap="truncate-end">
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
        </Text>
      </Box>
    </Box>
  );
});
