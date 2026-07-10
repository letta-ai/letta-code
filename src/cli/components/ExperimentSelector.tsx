// Experiment toggle picker.
// Wraps MultiSelectPicker with experiment-specific logic.

import { memo, useCallback, useMemo } from "react";
import type { ExperimentId, ExperimentSnapshot } from "@/experiments/types";
import { MultiSelectPicker } from "./MultiSelectPicker";
import { OverlayShell } from "./OverlayShell";

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
  const items = useMemo(
    () =>
      experiments.map((exp) => {
        const envOverrideAllowed = exp.id === "reflection_arena";
        return {
          key: exp.id,
          label: exp.label,
          description:
            exp.source === "env"
              ? `${envOverrideAllowed ? "set by environment; local override allowed" : "set by environment"} · ${exp.description}`
              : exp.description,
          disabled: exp.source === "env" && !envOverrideAllowed,
        };
      }),
    [experiments],
  );

  const initialSelected = useMemo(
    () =>
      new Set<string>(experiments.filter((e) => e.enabled).map((e) => e.id)),
    [experiments],
  );

  const handleConfirm = useCallback(
    (selectedKeys: string[]) => {
      const selectedSet = new Set(selectedKeys);
      const changes = experiments
        .filter((e) => e.source !== "env" || e.id === "reflection_arena")
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
    <OverlayShell command="/experiments" title="Toggle Experiments">
      <MultiSelectPicker
        items={items}
        selected={initialSelected}
        onConfirm={handleConfirm}
        onCancel={onCancel}
      />
    </OverlayShell>
  );
});
