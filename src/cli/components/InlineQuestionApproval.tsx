import { Box, useInput } from "ink";
import { Fragment, memo, useMemo, useState } from "react";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { useTextInputCursor } from "@/cli/hooks/use-text-input-cursor";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { Text } from "./Text";

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
}

type Props = {
  questions: Question[];
  onSubmit: (answers: Record<string, string>) => void;
  onCancel?: () => void;
  isFocused?: boolean;
};

const SOLID_LINE = "─";

const MARKDOWN_QUESTION_PATTERNS = [
  /^#{1,6}\s+/m,
  /^\s*[-*+]\s+/m,
  /^\s*\d+\.\s+/m,
  /^>\s+/m,
  /^```/m,
  /\|.+\|\n\|[\s:]*-+/m,
  /\*\*[^*]+\*\*/,
  /`[^`]+`/,
];

function shouldRenderQuestionAsMarkdown(question: string): boolean {
  return (
    question.includes("\n") ||
    MARKDOWN_QUESTION_PATTERNS.some((pattern) => pattern.test(question))
  );
}

export const InlineQuestionApproval = memo(
  ({ questions, onSubmit, onCancel, isFocused = true }: Props) => {
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [selectedOption, setSelectedOption] = useState(0);
    const {
      text: customText,
      setText: setCustomText,
      cursorPos,
      setCursorPos,
      handleKey,
      clear: clearCustomText,
    } = useTextInputCursor();
    const [selectedMulti, setSelectedMulti] = useState<Set<number>>(new Set());
    const columns = useTerminalWidth();
    useProgressIndicator();

    const currentQuestion = questions[currentQuestionIndex];

    const showOther = currentQuestion?.allowOther !== false;
    const baseOptions = currentQuestion
      ? [
          ...(Array.isArray(currentQuestion.options)
            ? currentQuestion.options.filter(
                (o): o is QuestionOption =>
                  o != null &&
                  typeof o === "object" &&
                  typeof (o as { label?: unknown }).label === "string" &&
                  typeof (o as { description?: unknown }).description ===
                    "string",
              )
            : []),
          ...(showOther ? [{ label: "Type something.", description: "" }] : []),
        ]
      : [];

    const optionsWithOther = currentQuestion?.multiSelect
      ? [...baseOptions, { label: "Submit", description: "" }]
      : baseOptions;

    const customOptionIndex = showOther ? baseOptions.length - 1 : -1;
    const submitOptionIndex = currentQuestion?.multiSelect
      ? optionsWithOther.length - 1
      : -1;

    const isOnCustomOption = showOther && selectedOption === customOptionIndex;
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
        clearCustomText();
        setSelectedMulti(new Set());
      } else {
        onSubmit(newAnswers);
      }
    };

    useInput(
      (input, key) => {
        if (!isFocused || !currentQuestion) return;

        if (key.ctrl && input === "c") {
          onCancel?.();
          return;
        }

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

        if (isOnCustomOption) {
          if (key.return) {
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
              if (customText.trim()) {
                handleSubmitAnswer(customText.trim());
              }
            }
            return;
          }
          if (input === " " && currentQuestion.multiSelect) {
            if (!selectedMulti.has(customOptionIndex)) {
              setSelectedMulti((prev) => {
                const newSet = new Set(prev);
                newSet.add(customOptionIndex);
                return newSet;
              });
            }
            setCustomText(
              (prev) => `${prev.slice(0, cursorPos)} ${prev.slice(cursorPos)}`,
            );
            setCursorPos((prev) => prev + 1);
            return;
          }
          if (key.escape) {
            if (customText) {
              clearCustomText();
            } else {
              onCancel?.();
            }
            return;
          }
          if (handleKey(input, key)) return;
        }

        if (isOnSubmitOption) {
          if (key.return) {
            const selectedLabels: string[] = [];
            for (const i of selectedMulti) {
              if (i === customOptionIndex) {
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

        if (key.escape) {
          onCancel?.();
          return;
        }

        if (key.return) {
          if (currentQuestion.multiSelect) {
            if (
              selectedOption !== customOptionIndex &&
              selectedOption !== submitOptionIndex
            ) {
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
            handleSubmitAnswer(optionsWithOther[selectedOption]?.label || "");
          }
          return;
        }

        if (input === " " && currentQuestion.multiSelect) {
          if (
            selectedOption !== customOptionIndex &&
            selectedOption !== submitOptionIndex
          ) {
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

        if (input >= "1" && input <= "9") {
          const optionIndex = Number.parseInt(input, 10) - 1;
          if (
            optionIndex >= 0 &&
            optionIndex < optionsWithOther.length &&
            optionIndex !== submitOptionIndex &&
            optionIndex !== customOptionIndex
          ) {
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

    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const questionText = currentQuestion?.question ?? "";
    const renderQuestionAsMarkdown =
      shouldRenderQuestionAsMarkdown(questionText);

    const memoizedHeaderContent = useMemo(
      () => (
        <>
          <Text dimColor>{solidLine}</Text>

          <Text>{currentQuestion?.header}</Text>

          <Box height={1} />

          {renderQuestionAsMarkdown ? (
            <MarkdownDisplay text={questionText} />
          ) : (
            <Text bold>{questionText}</Text>
          )}

          <Box height={1} />

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
        currentQuestionIndex,
        questions.length,
        questionText,
        renderQuestionAsMarkdown,
        solidLine,
      ],
    );

    const hintText = currentQuestion?.multiSelect
      ? "Enter to toggle · Arrow to navigate · Esc to cancel"
      : "Enter to select · Arrow to navigate · Esc to cancel";

    if (!currentQuestion) return null;

    return (
      <Box flexDirection="column">
        {memoizedHeaderContent}

        <Box flexDirection="column">
          {optionsWithOther.map((option, index) => {
            const isSelected = index === selectedOption;
            const isChecked = selectedMulti.has(index);
            const color = isSelected ? colors.approval.header : undefined;
            const isCustomOption = index === customOptionIndex;
            const isSubmitOption = index === submitOptionIndex;

            const selectorAndNumber = 5;
            const checkboxWidth = currentQuestion.multiSelect ? 4 : 0;
            const prefixWidth = selectorAndNumber + checkboxWidth;

            if (isSubmitOption) {
              return (
                <Box key="submit" flexDirection="column">
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

            return (
              <Fragment key={`${option.label}-${index}`}>
                <Box flexDirection="row">
                  <Box width={selectorAndNumber} flexShrink={0}>
                    <Text color={color}>
                      {isSelected ? "❯" : " "} {index + 1}.
                    </Text>
                  </Box>

                  {currentQuestion.multiSelect && (
                    <Box width={checkboxWidth} flexShrink={0}>
                      <Text color={isChecked ? "green" : color}>
                        [{isChecked ? "✓" : " "}]{" "}
                      </Text>
                    </Box>
                  )}

                  <Box flexGrow={1} width={Math.max(0, columns - prefixWidth)}>
                    {isCustomOption ? (
                      customText ? (
                        <Text wrap="wrap">
                          {customText.slice(0, cursorPos)}
                          {isSelected && "█"}
                          {customText.slice(cursorPos)}
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
