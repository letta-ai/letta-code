import { Box, Text, useInput } from "ink";
import { Fragment, memo, useMemo, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

type Props = {
  questions: Question[];
  onSubmit: (answers: Record<string, string>) => void;
  onCancel?: () => void;
  isFocused?: boolean;
};

// Horizontal line character for Claude Code style
const SOLID_LINE = "─";

export const InlineQuestionApproval = memo(
  ({ questions, onSubmit, onCancel, isFocused = true }: Props) => {
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [selectedOption, setSelectedOption] = useState(0);
    const [customText, setCustomText] = useState("");
    const [selectedMulti, setSelectedMulti] = useState<Set<number>>(new Set());
    const columns = useTerminalWidth();

    const currentQuestion = questions[currentQuestionIndex];

    // Build options list: regular options + "Type something"
    // For multi-select, we also track a separate "Submit" action
    const baseOptions = currentQuestion
      ? [
          ...currentQuestion.options,
          { label: "Type something.", description: "" },
        ]
      : [];

    // For multi-select, add Submit as a separate selectable item
    const optionsWithOther = currentQuestion?.multiSelect
      ? [...baseOptions, { label: "Submit", description: "" }]
      : baseOptions;

    const customOptionIndex = baseOptions.length - 1; // "Type something" index
    const submitOptionIndex = currentQuestion?.multiSelect
      ? optionsWithOther.length - 1
      : -1; // Submit index (only for multi-select)

    const isOnCustomOption = selectedOption === customOptionIndex;
    const isOnSubmitOption = selectedOption === submitOptionIndex;

    const handleSubmitAnswer = (answer: string) => {
      if (!currentQuestion) return;
      const newAnswers = {
        ...answers,
        [currentQuestion.question]: answer,
      };
      setAnswers(newAnswers);

      if (currentQuestionIndex < questions.length - 1) {
        setCurrentQuestionIndex(currentQuestionIndex + 1);
        setSelectedOption(0);
        setCustomText("");
        setSelectedMulti(new Set());
      } else {
        onSubmit(newAnswers);
      }
    };

    useInput(
      (input, key) => {
        if (!isFocused || !currentQuestion) return;

        // CTRL-C: cancel
        if (key.ctrl && input === "c") {
          onCancel?.();
          return;
        }

        // Arrow navigation always works
        if (key.upArrow) {
          setSelectedOption((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow || key.tab) {
          setSelectedOption((prev) =>
            Math.min(optionsWithOther.length - 1, prev + 1),
          );
          return;
        }

        // When on custom input option ("Type something")
        if (isOnCustomOption) {
          if (key.return) {
            // Enter toggles the checkbox (same as other options)
            if (currentQuestion.multiSelect) {
              setSelectedMulti((prev) => {
                const newSet = new Set(prev);
                if (newSet.has(customOptionIndex)) {
                  newSet.delete(customOptionIndex);
                } else {
                  newSet.add(customOptionIndex);
                }
                return newSet;
              });
            } else {
              // Single-select: submit the custom text if any
              if (customText.trim()) {
                handleSubmitAnswer(customText.trim());
              }
            }
            return;
          }
          if (input === " " && currentQuestion.multiSelect) {
            // Space: if not checked, toggle + insert space. If already checked, just insert space.
            if (!selectedMulti.has(customOptionIndex)) {
              setSelectedMulti((prev) => {
                const newSet = new Set(prev);
                newSet.add(customOptionIndex);
                return newSet;
              });
            }
            // Always insert the space character
            setCustomText((prev) => `${prev} `);
            return;
          }
          if (key.escape) {
            if (customText) {
              setCustomText("");
            } else {
              onCancel?.();
            }
            return;
          }
          if (key.backspace || key.delete) {
            setCustomText((prev) => prev.slice(0, -1));
            return;
          }
          if (input && !key.ctrl && !key.meta && input.length === 1) {
            setCustomText((prev) => prev + input);
          }
          return;
        }

        // When on Submit option (multi-select only)
        if (isOnSubmitOption) {
          if (key.return) {
            // Submit the selected options + custom text if "Type something" is checked
            const selectedLabels: string[] = [];
            for (const i of selectedMulti) {
              if (i === customOptionIndex) {
                // Include custom text if checkbox is checked and text was entered
                if (customText.trim()) {
                  selectedLabels.push(customText.trim());
                }
              } else {
                const label = baseOptions[i]?.label;
                if (label) {
                  selectedLabels.push(label);
                }
              }
            }
            if (selectedLabels.length > 0) {
              handleSubmitAnswer(selectedLabels.join(", "));
            }
            return;
          }
          if (key.escape) {
            onCancel?.();
            return;
          }
          return;
        }

        // ESC on regular options: cancel
        if (key.escape) {
          onCancel?.();
          return;
        }

        // Enter behavior depends on single vs multi-select
        if (key.return) {
          if (currentQuestion.multiSelect) {
            // Multi-select: Enter toggles the checkbox (only for regular options, not custom)
            if (selectedOption < customOptionIndex) {
              setSelectedMulti((prev) => {
                const newSet = new Set(prev);
                if (newSet.has(selectedOption)) {
                  newSet.delete(selectedOption);
                } else {
                  newSet.add(selectedOption);
                }
                return newSet;
              });
            }
          } else {
            // Single-select: Enter selects and submits
            handleSubmitAnswer(optionsWithOther[selectedOption]?.label || "");
          }
          return;
        }

        // Space also toggles for multi-select (like Claude Code) - only regular options
        if (input === " " && currentQuestion.multiSelect) {
          if (selectedOption < customOptionIndex) {
            setSelectedMulti((prev) => {
              const newSet = new Set(prev);
              if (newSet.has(selectedOption)) {
                newSet.delete(selectedOption);
              } else {
                newSet.add(selectedOption);
              }
              return newSet;
            });
          }
          return;
        }

        // Number keys for quick selection
        if (input >= "1" && input <= "9") {
          const optionIndex = Number.parseInt(input, 10) - 1;
          if (optionIndex < optionsWithOther.length - 1) {
            if (currentQuestion.multiSelect) {
              setSelectedMulti((prev) => {
                const newSet = new Set(prev);
                if (newSet.has(optionIndex)) {
                  newSet.delete(optionIndex);
                } else {
                  newSet.add(optionIndex);
                }
                return newSet;
              });
            } else {
              handleSubmitAnswer(optionsWithOther[optionIndex]?.label || "");
            }
          }
        }
      },
      { isActive: isFocused },
    );

    // Generate horizontal line
    const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));

    // Memoize the static header content so it doesn't re-render on keystroke
    // This prevents flicker when typing in the custom input field
    const memoizedHeaderContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header label */}
          <Text>{currentQuestion?.header}</Text>

          <Box height={1} />

          {/* Question */}
          <Text bold>{currentQuestion?.question}</Text>

          <Box height={1} />

          {/* Progress indicator for multiple questions */}
          {questions.length > 1 && (
            <Box marginBottom={1}>
              <Text dimColor>
                Question {currentQuestionIndex + 1} of {questions.length}
              </Text>
            </Box>
          )}
        </>
      ),
      [
        currentQuestion?.header,
        currentQuestion?.question,
        currentQuestionIndex,
        questions.length,
        solidLine,
      ],
    );

    // Hint text based on state - keep consistent to avoid jarring changes
    const hintText = currentQuestion?.multiSelect
      ? "Enter to toggle · Arrow to navigate · Esc to cancel"
      : "Enter to select · Arrow to navigate · Esc to cancel";

    if (!currentQuestion) return null;

    return (
      <Box flexDirection="column">
        {/* Static header content - memoized to prevent re-render on keystroke */}
        {memoizedHeaderContent}

        {/* Options - Format: ❯ N. [ ] Label (selector, number, checkbox, label) */}
        <Box flexDirection="column">
          {optionsWithOther.map((option, index) => {
            const isSelected = index === selectedOption;
            const isChecked = selectedMulti.has(index);
            const color = isSelected ? colors.approval.header : undefined;
            const isCustomOption = index === customOptionIndex;
            const isSubmitOption = index === submitOptionIndex;

            // Calculate prefix width: "❯ N. " = 5 chars, "[ ] " = 4 chars for multi-select
            const selectorAndNumber = 5; // "❯ N. " or "  N. "
            const checkboxWidth = currentQuestion.multiSelect ? 4 : 0; // "[ ] " or nothing
            const prefixWidth = selectorAndNumber + checkboxWidth;

            // Submit option renders differently (selector + always bold "Submit")
            if (isSubmitOption) {
              return (
                <Box key="submit" flexDirection="column">
                  {/* Extra newline above Submit */}
                  <Box height={1} />
                  <Box flexDirection="row">
                    <Box width={selectorAndNumber} flexShrink={0}>
                      <Text color={color}>
                        {isSelected ? "❯" : " "}
                        {"    "}
                      </Text>
                    </Box>
                    <Box flexGrow={1}>
                      <Text bold color={color}>
                        Submit
                      </Text>
                    </Box>
                  </Box>
                </Box>
              );
            }

            const hasDescription = option.description && !isCustomOption;

            // Use Fragment to avoid column Box wrapper - render row and description as siblings
            // Note: Can't use <> shorthand with key, so we import Fragment
            return (
              <Fragment key={`${option.label}-${index}`}>
                <Box flexDirection="row">
                  {/* Selector and number */}
                  <Box width={selectorAndNumber} flexShrink={0}>
                    <Text color={color}>
                      {isSelected ? "❯" : " "} {index + 1}.
                    </Text>
                  </Box>
                  {/* Checkbox (for multi-select) - single Text element to avoid re-mount */}
                  {currentQuestion.multiSelect && (
                    <Box width={checkboxWidth} flexShrink={0}>
                      <Text color={isChecked ? "green" : color}>
                        [{isChecked ? "✓" : " "}]{" "}
                      </Text>
                    </Box>
                  )}
                  {/* Label */}
                  <Box flexGrow={1} width={Math.max(0, columns - prefixWidth)}>
                    {isCustomOption ? (
                      // Custom input option ("Type something")
                      customText ? (
                        <Text wrap="wrap">
                          {customText}
                          {isSelected && "█"}
                        </Text>
                      ) : (
                        <Text wrap="wrap" dimColor>
                          {option.label}
                          {isSelected && "█"}
                        </Text>
                      )
                    ) : (
                      <Text wrap="wrap" color={color} bold={isSelected}>
                        {option.label}
                      </Text>
                    )}
                  </Box>
                </Box>
                {/* Description - rendered as sibling row */}
                {hasDescription && (
                  <Box paddingLeft={prefixWidth}>
                    <Text dimColor>{option.description}</Text>
                  </Box>
                )}
              </Fragment>
            );
          })}

          <Box marginTop={1}>
            <Text dimColor>{hintText}</Text>
          </Box>
        </Box>
      </Box>
    );
  },
);

InlineQuestionApproval.displayName = "InlineQuestionApproval";
