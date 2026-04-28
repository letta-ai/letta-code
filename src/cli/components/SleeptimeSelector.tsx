import { Box, useInput } from "ink";
import { Fragment, useEffect, useMemo, useState } from "react";
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
const DEFAULT_PASSIVE_CONVERSATION_MIN_IDLE_HOURS = "12";
const DEFAULT_PASSIVE_CONVERSATION_MIN_UNREFLECTED_TURNS = "3";
const TRIGGER_LABELS: Record<ReflectionTrigger, string> = {
  off: "Off",
  "step-count": "Step count",
  "compaction-event": "Compaction event",
};

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
  passiveConversationMinIdleHours: string;
  passiveConversationMinUnreflectedTurns: string;
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
    passiveConversationMinIdleHours: String(
      normalized.passiveConversationMinIdleHours > 0
        ? normalized.passiveConversationMinIdleHours
        : DEFAULT_PASSIVE_CONVERSATION_MIN_IDLE_HOURS,
    ),
    passiveConversationMinUnreflectedTurns: String(
      Number.isInteger(normalized.passiveConversationMinUnreflectedTurns) &&
        normalized.passiveConversationMinUnreflectedTurns > 0
        ? normalized.passiveConversationMinUnreflectedTurns
        : DEFAULT_PASSIVE_CONVERSATION_MIN_UNREFLECTED_TURNS,
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
  const [passiveConvIdleHoursInput, setPassiveConvIdleHoursInput] = useState(
    initialState.passiveConversationMinIdleHours,
  );
  const [
    passiveConvMinUnreflectedTurnsInput,
    setPassiveConvMinUnreflectedTurnsInput,
  ] = useState(initialState.passiveConversationMinUnreflectedTurns);
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
  const isEditingPassiveConvIdle =
    focusRow === "idle-min-age" && passiveSweepEnabled;
  const isEditingPassiveConvMinTurns =
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
    const passiveConversationMinIdleHours =
      parsePositiveNumber(passiveConvIdleHoursInput) ??
      Number(DEFAULT_PASSIVE_CONVERSATION_MIN_IDLE_HOURS);
    const passiveConversationMinUnreflectedTurns =
      parseStepCount(passiveConvMinUnreflectedTurnsInput) ??
      Number(DEFAULT_PASSIVE_CONVERSATION_MIN_UNREFLECTED_TURNS);

    if (passiveSweepEnabled) {
      if (parsePositiveNumber(passiveSweepIntervalInput) === null) {
        setValidationError("passive sweep interval must be a positive number");
        return;
      }
      if (parsePositiveNumber(passiveConvIdleHoursInput) === null) {
        setValidationError(
          "conversation min idle hours must be a positive number",
        );
        return;
      }
      if (parseStepCount(passiveConvMinUnreflectedTurnsInput) === null) {
        setValidationError(
          "conversation min unreflected turns must be a positive integer",
        );
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
        passiveConversationMinIdleHours,
        passiveConversationMinUnreflectedTurns,
      }),
    );
  };

  const renderTriggerOption = (option: ReflectionTrigger) => {
    const selected = trigger === option;
    return (
      <Fragment key={option}>
        <Text
          backgroundColor={
            selected ? colors.selector.itemHighlighted : undefined
          }
          color={selected ? "black" : undefined}
          bold={selected}
        >
          {` ${TRIGGER_LABELS[option]} `}
        </Text>
        <Text> </Text>
      </Fragment>
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
      !isEditingPassiveConvIdle &&
      !isEditingPassiveConvMinTurns
    ) {
      return;
    }

    if (key.backspace || key.delete) {
      if (isEditingStepCount) {
        setStepCountInput((prev) => prev.slice(0, -1));
      } else if (isEditingPassiveInterval) {
        setPassiveSweepIntervalInput((prev) => prev.slice(0, -1));
      } else if (isEditingPassiveConvIdle) {
        setPassiveConvIdleHoursInput((prev) => prev.slice(0, -1));
      } else if (isEditingPassiveConvMinTurns) {
        setPassiveConvMinUnreflectedTurnsInput((prev) => prev.slice(0, -1));
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
      } else if (isEditingPassiveConvIdle) {
        setPassiveConvIdleHoursInput((prev) => `${prev}${input}`);
      } else if (isEditingPassiveConvMinTurns) {
        setPassiveConvMinUnreflectedTurnsInput((prev) => `${prev}${input}`);
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

      <Box flexDirection="row">
        <Text>{focusRow === "trigger" ? "> " : "  "}</Text>
        <Text bold>Trigger event:</Text>
        <Text>{"   "}</Text>
        {triggerOptions.map(renderTriggerOption)}
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

      {memfsEnabled && (
        <>
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
                <Text bold>Conversation min idle hours: </Text>
                <Text>{passiveConvIdleHoursInput}</Text>
                {isEditingPassiveConvIdle && <Text>█</Text>}
              </Box>
              <Box flexDirection="row">
                <Text>{focusRow === "idle-min-turns" ? "> " : "  "}</Text>
                <Text bold>Conversation min unreflected turns: </Text>
                <Text>{passiveConvMinUnreflectedTurnsInput}</Text>
                {isEditingPassiveConvMinTurns && <Text>█</Text>}
              </Box>
              {validationError && focusRow !== "step-count" && (
                <Text color={colors.error.text}>
                  {`  error: ${validationError}`}
                </Text>
              )}
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
