import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { ModelReasoningEffort } from "../../agent/model";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const EFFORT_BLOCK = "▌";

interface ReasoningOption {
  effort: ModelReasoningEffort;
  modelId: string;
}

interface ModelReasoningSelectorProps {
  modelLabel: string;
  options: ReasoningOption[];
  initialModelId: string;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

function formatEffortLabel(effort: ModelReasoningEffort): string {
  if (effort === "none") return "Off";
  if (effort === "xhigh") return "Max";
  if (effort === "minimal") return "Minimal";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function ModelReasoningSelector({
  modelLabel,
  options,
  initialModelId,
  onSelect,
  onCancel,
}: ModelReasoningSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex(
      (option) => option.modelId === initialModelId,
    );
    return idx >= 0 ? idx : 0;
  });

  useEffect(() => {
    const idx = options.findIndex(
      (option) => option.modelId === initialModelId,
    );
    if (idx >= 0) {
      setSelectedIndex(idx);
    }
  }, [options, initialModelId]);

  const selectedOption = options[selectedIndex] ?? options[0];
  const effortOptions = useMemo(
    () => options.filter((option) => option.effort !== "none"),
    [options],
  );
  const totalBars = Math.max(effortOptions.length, 1);
  const selectedBars = useMemo(() => {
    if (!selectedOption) return 0;
    if (selectedOption.effort === "none") return 0;
    const effortIndex = effortOptions.findIndex(
      (option) => option.effort === selectedOption.effort,
    );
    return effortIndex >= 0 ? effortIndex + 1 : 0;
  }, [effortOptions, selectedOption]);

  useInput((input, key) => {
    if (options.length === 0) {
      if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
      }
      return;
    }

    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (selectedOption) {
        onSelect(selectedOption.modelId);
      }
      return;
    }

    if (key.leftArrow) {
      setSelectedIndex((prev) =>
        prev === 0 ? options.length - 1 : Math.max(0, prev - 1),
      );
      return;
    }

    if (key.rightArrow || key.tab) {
      setSelectedIndex((prev) => (prev + 1) % options.length);
    }
  });

  const effortLabel = selectedOption
    ? formatEffortLabel(selectedOption.effort)
    : "Medium";
  const selectedText =
    selectedBars > 0 ? EFFORT_BLOCK.repeat(selectedBars) : "";
  const remainingBars =
    totalBars > selectedBars
      ? EFFORT_BLOCK.repeat(totalBars - selectedBars)
      : "";

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /model"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Text bold color={colors.selector.title}>
        Set your model&apos;s reasoning settings
      </Text>

      <Box height={1} />

      <Box paddingLeft={1}>
        <Text>{modelLabel}</Text>
      </Box>

      <Box height={1} />

      <Box paddingLeft={1} flexDirection="row">
        <Text color={colors.selector.itemHighlighted}>{selectedText}</Text>
        <Text dimColor>{remainingBars}</Text>
        <Text> </Text>
        <Text bold>{effortLabel}</Text>
        <Text dimColor> reasoning effort</Text>
      </Box>

      <Box height={1} />

      <Box paddingLeft={1}>
        <Text dimColor>Enter select · ←→/Tab switch · Esc back</Text>
      </Box>
    </Box>
  );
}
