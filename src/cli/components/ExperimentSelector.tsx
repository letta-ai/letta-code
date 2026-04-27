import { Box, useInput } from "ink";
import { useEffect, useState } from "react";
import type { ExperimentId, ExperimentSnapshot } from "../../experiments/types";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";

interface ExperimentSelectorProps {
  experiments: ExperimentSnapshot[];
  onSelect: (selection: {
    experimentId: ExperimentId;
    enabled: boolean;
  }) => void;
  onCancel: () => void;
}

function formatExperimentState(experiment: ExperimentSnapshot): string {
  const state = experiment.enabled ? "on" : "off";
  if (experiment.source === "override") {
    return state;
  }
  if (experiment.source === "env") {
    return `${state} · env`;
  }
  return `${state} · default`;
}

export function ExperimentSelector({
  experiments,
  onSelect,
  onCancel,
}: ExperimentSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (selectedIndex >= experiments.length) {
      setSelectedIndex(Math.max(0, experiments.length - 1));
    }
  }, [experiments.length, selectedIndex]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(experiments.length - 1, prev + 1));
      return;
    }

    if (key.return) {
      const experiment = experiments[selectedIndex];
      if (experiment) {
        onSelect({
          experimentId: experiment.id,
          enabled: !experiment.enabled,
        });
      }
      return;
    }

    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /experiments"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Toggle experiments
        </Text>
      </Box>

      <Box flexDirection="column">
        {experiments.map((experiment, index) => {
          const isSelected = index === selectedIndex;

          return (
            <Box key={experiment.id} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {experiment.label}
              </Text>
              <Text dimColor>{` · ${formatExperimentState(experiment)}`}</Text>
              <Text dimColor>{` · ${experiment.description}`}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor> Enter toggle · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}
