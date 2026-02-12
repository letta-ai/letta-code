import { Box, useInput } from "ink";
import { useMemo, useState } from "react";
import type { MemoryReminderMode } from "../helpers/memoryReminder";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const DEFAULT_STEP_COUNT = "25";

type TriggerMode = "step-count" | "compaction-event";
type CompactionBehavior = "reminder" | "auto-launch";
type FocusRow = "trigger" | "value";

interface SleeptimeSelectorProps {
  initialMode: MemoryReminderMode;
  memfsEnabled: boolean;
  onSave: (mode: MemoryReminderMode) => void;
  onCancel: () => void;
}

function parseInitialState(initialMode: MemoryReminderMode): {
  trigger: TriggerMode;
  behavior: CompactionBehavior;
  stepCount: string;
} {
  if (typeof initialMode === "number" && Number.isFinite(initialMode)) {
    const value = Math.max(1, Math.floor(initialMode));
    return {
      trigger: "step-count",
      behavior: "reminder",
      stepCount: String(value),
    };
  }

  if (initialMode === "auto-compaction") {
    return {
      trigger: "compaction-event",
      behavior: "auto-launch",
      stepCount: DEFAULT_STEP_COUNT,
    };
  }

  if (initialMode === "compaction") {
    return {
      trigger: "compaction-event",
      behavior: "reminder",
      stepCount: DEFAULT_STEP_COUNT,
    };
  }

  return {
    trigger: "step-count",
    behavior: "reminder",
    stepCount: DEFAULT_STEP_COUNT,
  };
}

function nextTrigger(mode: TriggerMode): TriggerMode {
  return mode === "step-count" ? "compaction-event" : "step-count";
}

function nextBehavior(mode: CompactionBehavior): CompactionBehavior {
  return mode === "reminder" ? "auto-launch" : "reminder";
}

function parseStepCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function SleeptimeSelector({
  initialMode,
  memfsEnabled,
  onSave,
  onCancel,
}: SleeptimeSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const initialState = useMemo(
    () => parseInitialState(initialMode),
    [initialMode],
  );

  const [trigger, setTrigger] = useState<TriggerMode>(
    memfsEnabled ? initialState.trigger : "step-count",
  );
  const [behavior, setBehavior] = useState<CompactionBehavior>(
    initialState.behavior,
  );
  const [stepCountInput, setStepCountInput] = useState(initialState.stepCount);
  const [focusRow, setFocusRow] = useState<FocusRow>(
    memfsEnabled ? "trigger" : "value",
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const isEditingStepCount =
    !memfsEnabled || (focusRow === "value" && trigger === "step-count");

  const saveSelection = () => {
    if (!memfsEnabled || trigger === "step-count") {
      const stepCount = parseStepCount(stepCountInput);
      if (stepCount === null) {
        setValidationError("must be a positive integer");
        return;
      }
      onSave(stepCount);
      return;
    }

    onSave(behavior === "auto-launch" ? "auto-compaction" : "compaction");
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

    if (key.return) {
      saveSelection();
      return;
    }

    if (memfsEnabled && (key.upArrow || key.downArrow)) {
      setValidationError(null);
      setFocusRow((prev) => (prev === "trigger" ? "value" : "trigger"));
      return;
    }

    if (memfsEnabled && (key.leftArrow || key.rightArrow || key.tab)) {
      setValidationError(null);
      if (focusRow === "trigger") {
        setTrigger((prev) => nextTrigger(prev));
      } else if (trigger === "compaction-event") {
        setBehavior((prev) => nextBehavior(prev));
      }
      return;
    }

    if (!isEditingStepCount) return;

    if (key.backspace || key.delete) {
      setStepCountInput((prev) => prev.slice(0, -1));
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
      setStepCountInput((prev) => `${prev}${input}`);
      setValidationError(null);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /sleeptime"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Text bold color={colors.selector.title}>
        Configure your sleeptime (reflection) settings
      </Text>

      <Box height={1} />

      {memfsEnabled ? (
        <>
          <Box flexDirection="row">
            <Text>{focusRow === "trigger" ? "> " : "  "}</Text>
            <Text bold>Trigger:</Text>
            <Text>{"   "}</Text>
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

          <Box height={1} />

          {trigger === "step-count" ? (
            <Box flexDirection="row">
              <Text>{focusRow === "value" ? "> " : "  "}</Text>
              <Text bold>Step count: </Text>
              <Text>{stepCountInput}</Text>
              {isEditingStepCount && <Text>█</Text>}
              {validationError && (
                <Text color={colors.error.text}>
                  {` (error: ${validationError})`}
                </Text>
              )}
            </Box>
          ) : (
            <Box flexDirection="row">
              <Text>{focusRow === "value" ? "> " : "  "}</Text>
              <Text bold>Trigger behavior:</Text>
              <Text>{"  "}</Text>
              <Text
                backgroundColor={
                  behavior === "reminder"
                    ? colors.selector.itemHighlighted
                    : undefined
                }
                color={behavior === "reminder" ? "black" : undefined}
                bold={behavior === "reminder"}
              >
                {" Reminder "}
              </Text>
              <Text> </Text>
              <Text
                backgroundColor={
                  behavior === "auto-launch"
                    ? colors.selector.itemHighlighted
                    : undefined
                }
                color={behavior === "auto-launch" ? "black" : undefined}
                bold={behavior === "auto-launch"}
              >
                {" Auto-launch "}
              </Text>
            </Box>
          )}
        </>
      ) : (
        <Box flexDirection="row">
          <Text>{"> "}</Text>
          <Text bold>Step count: </Text>
          <Text>{stepCountInput}</Text>
          {isEditingStepCount && <Text>█</Text>}
          {validationError && (
            <Text color={colors.error.text}>
              {` (error: ${validationError})`}
            </Text>
          )}
        </Box>
      )}

      <Box height={1} />
      <Text dimColor>
        {"  Enter to save · ↑↓ rows · ←→/Tab options · Esc cancel"}
      </Text>
    </Box>
  );
}
