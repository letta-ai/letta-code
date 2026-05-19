// Compaction mode selector.
// Wraps SingleSelectPicker with compaction-specific logic.

import { memo, useMemo } from "react";
import { OverlayShell } from "./OverlayShell";
import { SingleSelectPicker } from "./SingleSelectPicker";

type CompactionMode =
  | "all"
  | "sliding_window"
  | "self_compact_all"
  | "self_compact_sliding_window";

const MODE_OPTIONS: CompactionMode[] = [
  "all",
  "sliding_window",
  "self_compact_all",
  "self_compact_sliding_window",
];

const MODE_LABELS: Record<CompactionMode, string> = {
  all: "All",
  sliding_window: "Sliding Window",
  self_compact_all: "Self Compact All",
  self_compact_sliding_window: "Self Compact Sliding Window",
};

const MODE_DESCRIPTIONS: Record<CompactionMode, string> = {
  all: "Compact the entire context window each time.",
  sliding_window: "Keep the most recent messages within a token limit.",
  self_compact_all: "Agent summarizes its entire context window itself.",
  self_compact_sliding_window:
    "Agent summarizes older messages to stay within a token limit.",
};

function parseMode(raw: string | null | undefined): CompactionMode {
  if (
    raw === "all" ||
    raw === "sliding_window" ||
    raw === "self_compact_all" ||
    raw === "self_compact_sliding_window"
  ) {
    return raw;
  }
  return "sliding_window";
}

interface CompactionSelectorProps {
  initialMode: string | null | undefined;
  onSave: (mode: CompactionMode) => void;
  onCancel: () => void;
}

export const CompactionSelector = memo(function CompactionSelector({
  initialMode,
  onSave,
  onCancel,
}: CompactionSelectorProps) {
  const currentMode = useMemo(() => parseMode(initialMode), [initialMode]);

  const items = useMemo(
    () =>
      MODE_OPTIONS.map((mode) => ({
        key: mode,
        label: MODE_LABELS[mode],
        description: MODE_DESCRIPTIONS[mode],
        isCurrent: mode === currentMode,
      })),
    [currentMode],
  );

  const initialCursorIndex = MODE_OPTIONS.indexOf(currentMode);

  return (
    <OverlayShell command="/compaction" title="Configure compaction mode">
      <SingleSelectPicker
        items={items}
        initialCursorIndex={initialCursorIndex}
        onSelect={(key) => onSave(key as CompactionMode)}
        onCancel={onCancel}
      />
    </OverlayShell>
  );
});
