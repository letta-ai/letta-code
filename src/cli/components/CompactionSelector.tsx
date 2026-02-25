import { Box, useInput } from "ink";
import { useMemo, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";

type CompactionMode = "all" | "sliding_window" | "self_compact_all" | "self_compact_sliding_window";
const MODE_OPTIONS: CompactionMode[] = ["all", "sliding_window", "self_compact_all", "self_compact_sliding_window"];
const MODE_LABELS: Record<CompactionMode, string> = {
  all: "All",
  sliding_window: "Sliding Window",
  self_compact_all: "Self Compact All",
  self_compact_sliding_window: "Self Compact Sliding Window",
};

function cycleOption<T extends string>(
  options: readonly T[],
  current: T,
  direction: -1 | 1,
): T {
  if (options.length === 0) {
    return current;
  }
  const currentIndex = options.indexOf(current);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + options.length) % options.length;
  return options[nextIndex] ?? current;
}

interface CompactionSelectorProps {
  initialMode: string | null | undefined;
  onSave: (mode: CompactionMode) => void;
  onCancel: () => void;
}

export function CompactionSelector({
  initialMode,
  onSave,
  onCancel,
}: CompactionSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  const parsedInitialMode = useMemo((): CompactionMode => {
    if (initialMode === "all" || initialMode === "sliding_window" || initialMode === "self_compact_all" || initialMode === "self_compact_sliding_window") {
      return initialMode as CompactionMode;
    }
    return "sliding_window";
  }, [initialMode]);

  const [mode, setMode] = useState<CompactionMode>(parsedInitialMode);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      onSave(mode);
      return;
    }

    if (key.leftArrow || key.rightArrow || key.tab) {
      const direction: -1 | 1 = key.leftArrow ? -1 : 1;
      setMode((prev) => cycleOption(MODE_OPTIONS, prev, direction));
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /compaction"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Text bold color={colors.selector.title}>
        Configure compaction mode
      </Text>

      <Box height={1} />

      <Box flexDirection="row">
        <Text>{"> "}</Text>
        <Text bold>Mode:</Text>
        <Text>{"   "}</Text>
        {MODE_OPTIONS.map((opt) => (
          <Box key={opt} flexDirection="row">
            <Text
              backgroundColor={
                mode === opt ? colors.selector.itemHighlighted : undefined
              }
              color={mode === opt ? "black" : undefined}
              bold={mode === opt}
            >
              {` ${MODE_LABELS[opt]} `}
            </Text>
            <Text> </Text>
          </Box>
        ))}
      </Box>

      <Box height={1} />
      <Text dimColor>
        {"  Enter to save · ←→/Tab options · Esc cancel"}
      </Text>
    </Box>
  );
}
