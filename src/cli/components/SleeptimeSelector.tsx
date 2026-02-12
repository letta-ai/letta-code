import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type {
  ReflectionBehavior,
  ReflectionSettings,
  ReflectionTrigger,
} from "../helpers/memoryReminder";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const DEFAULT_STEP_COUNT = "25";
const BEHAVIOR_OPTIONS: ReflectionBehavior[] = ["reminder", "auto-launch"];

type FocusRow = "trigger" | "behavior" | "step-count";

interface SleeptimeSelectorProps {
  initialSettings: ReflectionSettings;
  memfsEnabled: boolean;
  onSave: (settings: ReflectionSettings) => void;
  onCancel: () => void;
}

function getTriggerOptions(memfsEnabled: boolean): ReflectionTrigger[] {
  return memfsEnabled
    ? ["off", "step-count", "compaction-event"]
    : ["off", "step-count"];
}

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
  behavior: ReflectionBehavior;
  stepCount: string;
} {
  return {
    trigger:
      initialSettings.trigger === "off" ||
      initialSettings.trigger === "step-count" ||
      initialSettings.trigger === "compaction-event"
        ? initialSettings.trigger
        : "step-count",
    behavior:
      initialSettings.behavior === "auto-launch" ? "auto-launch" : "reminder",
    stepCount: String(
      Number.isInteger(initialSettings.stepCount) &&
        initialSettings.stepCount > 0
        ? initialSettings.stepCount
        : Number(DEFAULT_STEP_COUNT),
    ),
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

  const [trigger, setTrigger] = useState<ReflectionTrigger>(() => {
    if (!memfsEnabled && initialState.trigger === "compaction-event") {
      return "step-count";
    }
    return initialState.trigger;
  });
  const [behavior, setBehavior] = useState<ReflectionBehavior>(
    initialState.behavior,
  );
  const [stepCountInput, setStepCountInput] = useState(initialState.stepCount);
  const [focusRow, setFocusRow] = useState<FocusRow>("trigger");
  const [validationError, setValidationError] = useState<string | null>(null);
  const triggerOptions = useMemo(
    () => getTriggerOptions(memfsEnabled),
    [memfsEnabled],
  );
  const visibleRows = useMemo(() => {
    const rows: FocusRow[] = ["trigger"];
    if (memfsEnabled && trigger !== "off") {
      rows.push("behavior");
    }
    if (trigger === "step-count") {
      rows.push("step-count");
    }
    return rows;
  }, [memfsEnabled, trigger]);
  const isEditingStepCount =
    focusRow === "step-count" && trigger === "step-count";

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
        behavior: memfsEnabled ? behavior : "reminder",
        stepCount,
      });
      return;
    }

    const fallbackStepCount =
      parseStepCount(stepCountInput) ?? Number(DEFAULT_STEP_COUNT);
    onSave({
      trigger,
      behavior: memfsEnabled ? behavior : "reminder",
      stepCount: fallbackStepCount,
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
        setTrigger((prev) => cycleOption(triggerOptions, prev, direction));
      } else if (focusRow === "behavior" && memfsEnabled && trigger !== "off") {
        setBehavior((prev) => cycleOption(BEHAVIOR_OPTIONS, prev, direction));
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

          {trigger !== "off" && (
            <>
              <Box height={1} />
              <Box flexDirection="row">
                <Text>{focusRow === "behavior" ? "> " : "  "}</Text>
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
            </>
          )}

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
        </>
      ) : (
        <>
          <Box flexDirection="row">
            <Text>{focusRow === "trigger" ? "> " : "  "}</Text>
            <Text bold>Trigger:</Text>
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
        </>
      )}

      <Box height={1} />
      <Text dimColor>
        {"  Enter to save · ↑↓ rows · ←→/Tab options · Esc cancel"}
      </Text>
    </Box>
  );
}
