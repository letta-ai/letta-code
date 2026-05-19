// Experiment toggle picker.
// Wraps MultiSelectPicker with experiment-specific logic.

import { Box } from "ink";
import { memo, useCallback, useMemo } from "react";
import type { ExperimentId, ExperimentSnapshot } from "../../experiments/types";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { MultiSelectPicker } from "./MultiSelectPicker";
import { Text } from "./Text";

const SOLID_LINE = "─";

interface ExperimentSelectorProps {
  experiments: ExperimentSnapshot[];
  onConfirm: (
    changes: Array<{ experimentId: ExperimentId; enabled: boolean }>,
  ) => void;
  onCancel: () => void;
}

export const ExperimentSelector = memo(function ExperimentSelector({
  experiments,
  onConfirm,
  onCancel,
}: ExperimentSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  const items = useMemo(
    () =>
      experiments.map((exp) => ({
        key: exp.id,
        label: exp.label,
        description:
          exp.source === "env"
            ? `set by environment · ${exp.description}`
            : exp.description,
        disabled: exp.source === "env",
      })),
    [experiments],
  );

  const initialSelected = useMemo(
    () => new Set(experiments.filter((e) => e.enabled).map((e) => e.id)),
    [experiments],
  );

  const handleConfirm = useCallback(
    (selectedKeys: string[]) => {
      const selectedSet = new Set(selectedKeys);
      const changes = experiments
        .filter((e) => e.source !== "env")
        .flatMap((e) => {
          const nowEnabled = selectedSet.has(e.id);
          return nowEnabled !== e.enabled
            ? [{ experimentId: e.id as ExperimentId, enabled: nowEnabled }]
            : [];
        });
      onConfirm(changes);
    },
    [experiments, onConfirm],
  );

  return (
    <>
      <Text dimColor>{"> /experiments"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />
      <MultiSelectPicker
        title="Toggle Experiments"
        description="Select which experiments to enable."
        items={items}
        selected={initialSelected}
        onConfirm={handleConfirm}
        onCancel={onCancel}
      />
    </>
  );
});
