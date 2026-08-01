import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type {
  ReflectionMergeMode,
  ReflectionSettings,
  ReflectionTrigger,
} from "@/cli/helpers/memory-reminder";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const DEFAULT_STEP_COUNT = "25";

type FocusRow = "trigger" | "step-count" | "merge" | "merge-instructions";

interface SleeptimeSelectorProps {
  initialSettings: ReflectionSettings;
  memfsEnabled: boolean;
  onSave: (settings: ReflectionSettings) => void;
  onCancel: () => void;
}

const TRIGGER_OPTIONS: readonly ReflectionTrigger[] = [
  "off",
  "step-count",
  "compaction-event",
];
const MERGE_OPTIONS: readonly ReflectionMergeMode[] = ["auto", "explicit"];

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

function parseInitialState(initialSettings: ReflectionSettings): {
  trigger: ReflectionTrigger;
  stepCount: string;
  merge: ReflectionMergeMode;
  mergeInstructions: string;
} {
  return {
    trigger:
      initialSettings.trigger === "off" ||
      initialSettings.trigger === "step-count" ||
      initialSettings.trigger === "compaction-event"
        ? initialSettings.trigger
        : "step-count",
    stepCount: String(
      Number.isInteger(initialSettings.stepCount) &&
        initialSettings.stepCount > 0
        ? initialSettings.stepCount
        : Number(DEFAULT_STEP_COUNT),
    ),
    merge: initialSettings.merge === "explicit" ? "explicit" : "auto",
    mergeInstructions: initialSettings.mergeInstructions ?? "",
  };
}

function parseStepCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function SleeptimeSelector({
  initialSettings,
  memfsEnabled,
  onSave,
  onCancel,
}: SleeptimeSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const initialState = useMemo(
    () => parseInitialState(initialSettings),
    [initialSettings],
  );

  const [trigger, setTrigger] = useState<ReflectionTrigger>(
    initialState.trigger,
  );
  const [stepCountInput, setStepCountInput] = useState(initialState.stepCount);
  const [merge, setMerge] = useState<ReflectionMergeMode>(initialState.merge);
  const [mergeInstructions, setMergeInstructions] = useState(
    initialState.mergeInstructions,
  );
  const [focusRow, setFocusRow] = useState<FocusRow>("trigger");
  const [validationError, setValidationError] = useState<string | null>(null);
  const visibleRows = useMemo(() => {
    const rows: FocusRow[] = ["trigger"];
    if (trigger === "step-count") {
      rows.push("step-count");
    }
    rows.push("merge");
    if (merge === "explicit") {
      rows.push("merge-instructions");
    }
    return rows;
  }, [merge, trigger]);
  const isEditingStepCount =
    focusRow === "step-count" && trigger === "step-count";
  const isEditingMergeInstructions =
    focusRow === "merge-instructions" && merge === "explicit";

  useEffect(() => {
    if (!visibleRows.includes(focusRow)) {
      setFocusRow(visibleRows[visibleRows.length - 1] ?? "trigger");
    }
  }, [focusRow, visibleRows]);

  const saveSelection = () => {
    if (trigger === "step-count") {
      const stepCount = parseStepCount(stepCountInput);
      if (stepCount === null) {
        setValidationError("must be a positive integer");
        return;
      }
      onSave({
        trigger,
        stepCount,
        merge,
        mergeInstructions,
      });
      return;
    }

    const fallbackStepCount =
      parseStepCount(stepCountInput) ?? Number(DEFAULT_STEP_COUNT);
    onSave({
      trigger,
      stepCount: fallbackStepCount,
      merge,
      mergeInstructions,
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (!memfsEnabled) {
      if (key.return) {
        onCancel();
      }
      return;
    }

    if (key.return) {
      saveSelection();
      return;
    }

    if (key.upArrow || key.downArrow) {
      if (visibleRows.length === 0) return;
      setValidationError(null);
      const direction = key.downArrow ? 1 : -1;
      const currentIndex = visibleRows.indexOf(focusRow);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        (safeIndex + direction + visibleRows.length) % visibleRows.length;
      const nextRow = visibleRows[nextIndex] ?? "trigger";
      setFocusRow(nextRow);
      return;
    }

    if (key.leftArrow || key.rightArrow || key.tab) {
      setValidationError(null);
      const direction: -1 | 1 = key.leftArrow ? -1 : 1;
      if (focusRow === "trigger") {
        setTrigger((prev) => cycleOption(TRIGGER_OPTIONS, prev, direction));
      } else if (focusRow === "merge") {
        setMerge((prev) => cycleOption(MERGE_OPTIONS, prev, direction));
      }
      return;
    }

    if (!isEditingStepCount && !isEditingMergeInstructions) return;

    if (key.backspace || key.delete) {
      if (isEditingStepCount) {
        setStepCountInput((prev) => prev.slice(0, -1));
      } else {
        setMergeInstructions((prev) => prev.slice(0, -1));
      }
      setValidationError(null);
      return;
    }

    // Allow arbitrary typing and validate only when saving.
    if (
      input &&
      input.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow
    ) {
      if (isEditingStepCount) {
        setStepCountInput((prev) => `${prev}${input}`);
      } else {
        setMergeInstructions((prev) => `${prev}${input}`);
      }
      setValidationError(null);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /sleeptime"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Text bold color={colors.selector.title}>
        Configure your sleep-time (dream) settings
      </Text>

      <Box height={1} />

      {memfsEnabled ? (
        <>
          <Box flexDirection="row">
            <Text>{focusRow === "trigger" ? "> " : "  "}</Text>
            <Text bold>Trigger event:</Text>
            <Text>{"   "}</Text>
            <Text
              backgroundColor={
                trigger === "off" ? colors.selector.itemHighlighted : undefined
              }
              color={trigger === "off" ? "black" : undefined}
              bold={trigger === "off"}
            >
              {" Off "}
            </Text>
            <Text> </Text>
            <Text
              backgroundColor={
                trigger === "step-count"
                  ? colors.selector.itemHighlighted
                  : undefined
              }
              color={trigger === "step-count" ? "black" : undefined}
              bold={trigger === "step-count"}
            >
              {" Step count "}
            </Text>
            <Text> </Text>
            <Text
              backgroundColor={
                trigger === "compaction-event"
                  ? colors.selector.itemHighlighted
                  : undefined
              }
              color={trigger === "compaction-event" ? "black" : undefined}
              bold={trigger === "compaction-event"}
            >
              {" Compaction event "}
            </Text>
          </Box>

          {trigger === "step-count" && (
            <>
              <Box height={1} />
              <Box flexDirection="row">
                <Text>{focusRow === "step-count" ? "> " : "  "}</Text>
                <Text bold>Step count: </Text>
                <Text>{stepCountInput}</Text>
                {isEditingStepCount && <Text>█</Text>}
                {validationError && (
                  <Text color={colors.error.text}>
                    {` (error: ${validationError})`}
                  </Text>
                )}
              </Box>
            </>
          )}

          <Box height={1} />
          <Box flexDirection="row">
            <Text>{focusRow === "merge" ? "> " : "  "}</Text>
            <Text bold>Merge:</Text>
            <Text>{"   "}</Text>
            <Text
              backgroundColor={
                merge === "auto" ? colors.selector.itemHighlighted : undefined
              }
              color={merge === "auto" ? "black" : undefined}
              bold={merge === "auto"}
            >
              {" Auto "}
            </Text>
            <Text> </Text>
            <Text
              backgroundColor={
                merge === "explicit"
                  ? colors.selector.itemHighlighted
                  : undefined
              }
              color={merge === "explicit" ? "black" : undefined}
              bold={merge === "explicit"}
            >
              {" Explicit integration "}
            </Text>
          </Box>

          {merge === "explicit" && (
            <>
              <Box height={1} />
              <Box flexDirection="row">
                <Text>{focusRow === "merge-instructions" ? "> " : "  "}</Text>
                <Text bold>Integration instructions: </Text>
                <Text>{mergeInstructions || "(none)"}</Text>
                {isEditingMergeInstructions && <Text>█</Text>}
              </Box>
            </>
          )}

          <Box height={1} />
          <Text dimColor>
            {"  Enter to save · ↑↓ rows · ←→/Tab options · Esc cancel"}
          </Text>
        </>
      ) : (
        <>
          <Text>
            Sleep-time reflection requires the memory filesystem (memfs) to be
            enabled for this agent.
          </Text>

          <Box height={1} />
          <Text dimColor>{"  Enter or Esc to close"}</Text>
        </>
      )}
    </Box>
  );
}
