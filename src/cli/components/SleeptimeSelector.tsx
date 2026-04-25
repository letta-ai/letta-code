import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type {
  ReflectionSettings,
  ReflectionTrigger,
} from "../helpers/memoryReminder";
import { normalizeReflectionSettings } from "../helpers/memoryReminder";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const DEFAULT_STEP_COUNT = "25";
const DEFAULT_PASSIVE_SWEEP_INTERVAL_HOURS = "24";
const DEFAULT_PASSIVE_MIN_QUIET_MINUTES = "15";
const DEFAULT_PASSIVE_MIN_UNREFLECTED_TURNS = "3";

type FocusRow =
  | "trigger"
  | "step-count"
  | "idle-enabled"
  | "idle-interval"
  | "idle-min-age"
  | "idle-min-turns";

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
  stepCount: string;
  passiveSweepEnabled: boolean;
  passiveSweepIntervalHours: string;
  passiveMinQuietMinutes: string;
  passiveMinUnreflectedTurns: string;
} {
  const normalized = normalizeReflectionSettings(initialSettings);
  return {
    trigger:
      normalized.activeTrigger === "off" ||
      normalized.activeTrigger === "step-count" ||
      normalized.activeTrigger === "compaction-event"
        ? normalized.activeTrigger
        : "step-count",
    stepCount: String(
      Number.isInteger(normalized.activeStepCount) &&
        normalized.activeStepCount > 0
        ? normalized.activeStepCount
        : Number(DEFAULT_STEP_COUNT),
    ),
    passiveSweepEnabled: normalized.passiveSweepEnabled,
    passiveSweepIntervalHours: String(
      normalized.passiveSweepIntervalHours > 0
        ? normalized.passiveSweepIntervalHours
        : DEFAULT_PASSIVE_SWEEP_INTERVAL_HOURS,
    ),
    passiveMinQuietMinutes: String(
      normalized.passiveMinQuietMinutes > 0
        ? normalized.passiveMinQuietMinutes
        : DEFAULT_PASSIVE_MIN_QUIET_MINUTES,
    ),
    passiveMinUnreflectedTurns: String(
      Number.isInteger(normalized.passiveMinUnreflectedTurns) &&
        normalized.passiveMinUnreflectedTurns > 0
        ? normalized.passiveMinUnreflectedTurns
        : DEFAULT_PASSIVE_MIN_UNREFLECTED_TURNS,
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

function parsePositiveNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
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
  const [stepCountInput, setStepCountInput] = useState(initialState.stepCount);
  const [passiveSweepEnabled, setPassiveSweepEnabled] = useState(
    initialState.passiveSweepEnabled,
  );
  const [passiveSweepIntervalInput, setPassiveSweepIntervalInput] = useState(
    initialState.passiveSweepIntervalHours,
  );
  const [passiveQuietMinutesInput, setPassiveQuietMinutesInput] = useState(
    initialState.passiveMinQuietMinutes,
  );
  const [passiveMinUnreflectedTurnsInput, setPassiveMinUnreflectedTurnsInput] =
    useState(initialState.passiveMinUnreflectedTurns);
  const [focusRow, setFocusRow] = useState<FocusRow>("trigger");
  const [validationError, setValidationError] = useState<string | null>(null);
  const triggerOptions = useMemo(
    () => getTriggerOptions(memfsEnabled),
    [memfsEnabled],
  );
  const visibleRows = useMemo(() => {
    const rows: FocusRow[] = ["trigger"];
    if (trigger === "step-count") {
      rows.push("step-count");
    }
    if (memfsEnabled) {
      rows.push("idle-enabled");
      if (passiveSweepEnabled) {
        rows.push("idle-interval", "idle-min-age", "idle-min-turns");
      }
    }
    return rows;
  }, [trigger, memfsEnabled, passiveSweepEnabled]);
  const isEditingStepCount =
    focusRow === "step-count" && trigger === "step-count";
  const isEditingPassiveInterval =
    focusRow === "idle-interval" && passiveSweepEnabled;
  const isEditingPassiveQuiet =
    focusRow === "idle-min-age" && passiveSweepEnabled;
  const isEditingPassiveMinTurns =
    focusRow === "idle-min-turns" && passiveSweepEnabled;

  useEffect(() => {
    if (!visibleRows.includes(focusRow)) {
      setFocusRow(visibleRows[visibleRows.length - 1] ?? "trigger");
    }
  }, [focusRow, visibleRows]);

  const saveSelection = () => {
    const stepCount =
      parseStepCount(stepCountInput) ?? Number(DEFAULT_STEP_COUNT);
    if (trigger === "step-count" && parseStepCount(stepCountInput) === null) {
      setValidationError("step count must be a positive integer");
      return;
    }
    const passiveSweepIntervalHours =
      parsePositiveNumber(passiveSweepIntervalInput) ??
      Number(DEFAULT_PASSIVE_SWEEP_INTERVAL_HOURS);
    const passiveMinQuietMinutes =
      parsePositiveNumber(passiveQuietMinutesInput) ??
      Number(DEFAULT_PASSIVE_MIN_QUIET_MINUTES);
    const passiveMinUnreflectedTurns =
      parseStepCount(passiveMinUnreflectedTurnsInput) ??
      Number(DEFAULT_PASSIVE_MIN_UNREFLECTED_TURNS);

    if (passiveSweepEnabled) {
      if (parsePositiveNumber(passiveSweepIntervalInput) === null) {
        setValidationError("passive sweep interval must be a positive number");
        return;
      }
      if (parsePositiveNumber(passiveQuietMinutesInput) === null) {
        setValidationError("passive quiet minutes must be a positive number");
        return;
      }
      if (parseStepCount(passiveMinUnreflectedTurnsInput) === null) {
        setValidationError("passive min turns must be a positive integer");
        return;
      }
    }

    onSave(
      normalizeReflectionSettings({
        trigger,
        stepCount,
        activeTrigger: trigger,
        activeStepCount: stepCount,
        passiveSweepEnabled: memfsEnabled ? passiveSweepEnabled : false,
        passiveSweepIntervalHours,
        passiveMinQuietMinutes,
        passiveMinUnreflectedTurns,
      }),
    );
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
      } else if (focusRow === "idle-enabled") {
        setPassiveSweepEnabled((prev) => !prev);
      }
      return;
    }

    if (
      !isEditingStepCount &&
      !isEditingPassiveInterval &&
      !isEditingPassiveQuiet &&
      !isEditingPassiveMinTurns
    ) {
      return;
    }

    if (key.backspace || key.delete) {
      if (isEditingStepCount) {
        setStepCountInput((prev) => prev.slice(0, -1));
      } else if (isEditingPassiveInterval) {
        setPassiveSweepIntervalInput((prev) => prev.slice(0, -1));
      } else if (isEditingPassiveQuiet) {
        setPassiveQuietMinutesInput((prev) => prev.slice(0, -1));
      } else if (isEditingPassiveMinTurns) {
        setPassiveMinUnreflectedTurnsInput((prev) => prev.slice(0, -1));
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
      } else if (isEditingPassiveInterval) {
        setPassiveSweepIntervalInput((prev) => `${prev}${input}`);
      } else if (isEditingPassiveQuiet) {
        setPassiveQuietMinutesInput((prev) => `${prev}${input}`);
      } else if (isEditingPassiveMinTurns) {
        setPassiveMinUnreflectedTurnsInput((prev) => `${prev}${input}`);
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
                {validationError && focusRow === "step-count" && (
                  <Text color={colors.error.text}>
                    {` (error: ${validationError})`}
                  </Text>
                )}
              </Box>
            </>
          )}

          <Box height={1} />
          <Box flexDirection="row">
            <Text>{focusRow === "idle-enabled" ? "> " : "  "}</Text>
            <Text bold>Passive sweep:</Text>
            <Text>{"   "}</Text>
            <Text
              backgroundColor={
                passiveSweepEnabled
                  ? colors.selector.itemHighlighted
                  : undefined
              }
              color={passiveSweepEnabled ? "black" : undefined}
              bold={passiveSweepEnabled}
            >
              {" On "}
            </Text>
            <Text> </Text>
            <Text
              backgroundColor={
                !passiveSweepEnabled
                  ? colors.selector.itemHighlighted
                  : undefined
              }
              color={!passiveSweepEnabled ? "black" : undefined}
              bold={!passiveSweepEnabled}
            >
              {" Off "}
            </Text>
          </Box>

          {passiveSweepEnabled && (
            <>
              <Box height={1} />
              <Box flexDirection="row">
                <Text>{focusRow === "idle-interval" ? "> " : "  "}</Text>
                <Text bold>Passive sweep interval hours: </Text>
                <Text>{passiveSweepIntervalInput}</Text>
                {isEditingPassiveInterval && <Text>█</Text>}
              </Box>
              <Box flexDirection="row">
                <Text>{focusRow === "idle-min-age" ? "> " : "  "}</Text>
                <Text bold>Passive quiet minutes: </Text>
                <Text>{passiveQuietMinutesInput}</Text>
                {isEditingPassiveQuiet && <Text>█</Text>}
              </Box>
              <Box flexDirection="row">
                <Text>{focusRow === "idle-min-turns" ? "> " : "  "}</Text>
                <Text bold>Passive min unreflected turns: </Text>
                <Text>{passiveMinUnreflectedTurnsInput}</Text>
                {isEditingPassiveMinTurns && <Text>█</Text>}
              </Box>
              {validationError && focusRow !== "step-count" && (
                <Text color={colors.error.text}>
                  {`  error: ${validationError}`}
                </Text>
              )}
            </>
          )}
        </>
      ) : (
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
          </Box>

          {trigger === "step-count" && (
            <>
              <Box height={1} />
              <Box flexDirection="row">
                <Text>{focusRow === "step-count" ? "> " : "  "}</Text>
                <Text bold>Step count: </Text>
                <Text>{stepCountInput}</Text>
                {isEditingStepCount && <Text>█</Text>}
                {validationError && focusRow === "step-count" && (
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
