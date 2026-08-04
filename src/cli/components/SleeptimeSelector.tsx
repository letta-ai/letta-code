import { Box, useInput } from "ink";
import { type ReactNode, useEffect, useMemo, useState } from "react";
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

type FocusRow =
  | "trigger-off"
  | "trigger-step-count"
  | "trigger-compaction"
  | "merge-auto"
  | "merge-explicit"
  | "merge-instructions";

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

function triggerFocusRow(trigger: ReflectionTrigger): FocusRow {
  switch (trigger) {
    case "off":
      return "trigger-off";
    case "step-count":
      return "trigger-step-count";
    case "compaction-event":
      return "trigger-compaction";
  }
}

function mergeFocusRow(merge: ReflectionMergeMode): FocusRow {
  return merge === "explicit" ? "merge-explicit" : "merge-auto";
}

function ChoiceRow(props: {
  focused: boolean;
  selected: boolean;
  children: ReactNode;
}) {
  const { focused, selected, children } = props;
  return (
    <Box flexDirection="row">
      <Text>{focused ? "> " : "  "}</Text>
      <Text
        backgroundColor={selected ? colors.selector.itemHighlighted : undefined}
        color={selected ? "black" : undefined}
        bold={selected}
      >
        {children}
      </Text>
    </Box>
  );
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
  const [focusRow, setFocusRow] = useState<FocusRow>(() =>
    triggerFocusRow(initialState.trigger),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const visibleRows = useMemo(() => {
    const rows: FocusRow[] = [
      "trigger-off",
      "trigger-step-count",
      "trigger-compaction",
      "merge-auto",
      "merge-explicit",
    ];
    if (merge === "explicit") {
      rows.push("merge-instructions");
    }
    return rows;
  }, [merge]);
  const isEditingStepCount = focusRow === "trigger-step-count";
  const isEditingMergeInstructions =
    focusRow === "merge-instructions" && merge === "explicit";

  useEffect(() => {
    if (!visibleRows.includes(focusRow)) {
      setFocusRow(visibleRows[visibleRows.length - 1] ?? "trigger-off");
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

  const selectFocusedOption = () => {
    switch (focusRow) {
      case "trigger-off":
        setTrigger("off");
        break;
      case "trigger-step-count":
        setTrigger("step-count");
        break;
      case "trigger-compaction":
        setTrigger("compaction-event");
        break;
      case "merge-auto":
        setMerge("auto");
        break;
      case "merge-explicit":
        setMerge("explicit");
        break;
      case "merge-instructions":
        break;
    }
    setValidationError(null);
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

    if (key.upArrow || key.downArrow || key.tab) {
      if (visibleRows.length === 0) return;
      setValidationError(null);
      const direction = key.upArrow ? -1 : 1;
      const currentIndex = visibleRows.indexOf(focusRow);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        (safeIndex + direction + visibleRows.length) % visibleRows.length;
      const nextRow = visibleRows[nextIndex] ?? "trigger-off";
      setFocusRow(nextRow);
      return;
    }

    if (input === " " && !isEditingMergeInstructions) {
      selectFocusedOption();
      return;
    }

    if (key.leftArrow || key.rightArrow) {
      setValidationError(null);
      const direction: -1 | 1 = key.leftArrow ? -1 : 1;
      if (focusRow.startsWith("trigger-")) {
        const nextTrigger = cycleOption(TRIGGER_OPTIONS, trigger, direction);
        setTrigger(nextTrigger);
        setFocusRow(triggerFocusRow(nextTrigger));
      } else if (focusRow.startsWith("merge-")) {
        const nextMerge = cycleOption(MERGE_OPTIONS, merge, direction);
        setMerge(nextMerge);
        setFocusRow(mergeFocusRow(nextMerge));
      }
      return;
    }

    if (!isEditingStepCount && !isEditingMergeInstructions) return;

    if (key.backspace || key.delete) {
      if (isEditingStepCount) {
        setTrigger("step-count");
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
        setTrigger("step-count");
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

      {memfsEnabled ? (
        <>
          <Text bold color={colors.selector.title}>
            Dream Settings
          </Text>
          <Box height={1} />
          <ChoiceRow
            focused={focusRow === "trigger-off"}
            selected={trigger === "off"}
          >
            {" Off "}
          </ChoiceRow>
          <ChoiceRow
            focused={focusRow === "trigger-step-count"}
            selected={trigger === "step-count"}
          >
            {` Every [${stepCountInput}${isEditingStepCount ? "█" : ""}] steps `}
          </ChoiceRow>
          {validationError && (
            <Text color={colors.error.text}>
              {`    Error: ${validationError}`}
            </Text>
          )}
          <ChoiceRow
            focused={focusRow === "trigger-compaction"}
            selected={trigger === "compaction-event"}
          >
            {" On compaction "}
          </ChoiceRow>

          <Box height={1} />
          <Text bold color={colors.selector.title}>
            Memory updates
          </Text>
          <Box height={1} />
          <ChoiceRow
            focused={focusRow === "merge-auto"}
            selected={merge === "auto"}
          >
            {" Apply automatically "}
          </ChoiceRow>
          <ChoiceRow
            focused={focusRow === "merge-explicit"}
            selected={merge === "explicit"}
          >
            {" Agent reviews before applying "}
          </ChoiceRow>

          {merge === "explicit" && (
            <>
              <Box height={1} />
              <Text bold>{"  Review instructions"}</Text>
              <Box flexDirection="row">
                <Text>{focusRow === "merge-instructions" ? "> " : "  "}</Text>
                <Text>
                  {`[${mergeInstructions}${isEditingMergeInstructions ? "█" : ""}]`}
                </Text>
              </Box>
            </>
          )}

          <Box height={1} />
          <Text dimColor>
            {
              "  Enter save · ↑↓/Tab move · Space select · ←→ options · Esc cancel"
            }
          </Text>
        </>
      ) : (
        <>
          <Text>
            Dream settings require the memory filesystem (MemFS) to be enabled
            for this agent.
          </Text>

          <Box height={1} />
          <Text dimColor>{"  Enter or Esc to close"}</Text>
        </>
      )}
    </Box>
  );
}
