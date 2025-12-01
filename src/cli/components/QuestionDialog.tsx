import { Box, Text, useInput } from "ink";
import { memo, useState } from "react";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

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
};

export const QuestionDialog = memo(({ questions, onSubmit }: Props) => {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedOption, setSelectedOption] = useState(0);
  const [isOtherMode, setIsOtherMode] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [selectedMulti, setSelectedMulti] = useState<Set<number>>(new Set());

  const currentQuestion = questions[currentQuestionIndex];
  const optionsWithOther = currentQuestion
    ? [
        ...currentQuestion.options,
        { label: "Other", description: "Provide a custom response" },
      ]
    : [];

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
      setIsOtherMode(false);
      setOtherText("");
      setSelectedMulti(new Set());
    } else {
      onSubmit(newAnswers);
    }
  };

  useInput((input, key) => {
    if (!currentQuestion) return;

    if (isOtherMode) {
      if (key.escape) {
        setIsOtherMode(false);
        setOtherText("");
      }
      return;
    }

    if (key.upArrow) {
      setSelectedOption((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedOption((prev) =>
        Math.min(optionsWithOther.length - 1, prev + 1),
      );
    } else if (key.return) {
      if (currentQuestion.multiSelect) {
        if (selectedOption === optionsWithOther.length - 1) {
          setIsOtherMode(true);
        } else if (selectedMulti.size > 0) {
          const selectedLabels = Array.from(selectedMulti)
            .map((i) => optionsWithOther[i]?.label)
            .filter(Boolean)
            .join(", ");
          handleSubmitAnswer(selectedLabels);
        }
      } else {
        if (selectedOption === optionsWithOther.length - 1) {
          setIsOtherMode(true);
        } else {
          handleSubmitAnswer(optionsWithOther[selectedOption]?.label || "");
        }
      }
    } else if (input === " " && currentQuestion.multiSelect) {
      if (selectedOption < optionsWithOther.length - 1) {
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
    } else if (input >= "1" && input <= "9") {
      const optionIndex = Number.parseInt(input, 10) - 1;
      if (optionIndex < optionsWithOther.length) {
        if (currentQuestion.multiSelect) {
          if (optionIndex < optionsWithOther.length - 1) {
            setSelectedMulti((prev) => {
              const newSet = new Set(prev);
              if (newSet.has(optionIndex)) {
                newSet.delete(optionIndex);
              } else {
                newSet.add(optionIndex);
              }
              return newSet;
            });
          }
        } else {
          if (optionIndex === optionsWithOther.length - 1) {
            setIsOtherMode(true);
          } else {
            handleSubmitAnswer(optionsWithOther[optionIndex]?.label || "");
          }
        }
      }
    }
  });

  const handleOtherSubmit = (text: string) => {
    handleSubmitAnswer(text);
  };

  if (!currentQuestion) return null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={colors.approval.header}>
          <Text bold>[{currentQuestion.header}]</Text>{" "}
          {currentQuestion.question}
        </Text>
      </Box>

      {questions.length > 1 && (
        <Box marginBottom={1}>
          <Text dimColor>
            Question {currentQuestionIndex + 1} of {questions.length}
          </Text>
        </Box>
      )}

      {isOtherMode ? (
        <Box flexDirection="column">
          <Text dimColor>Type your response (Esc to cancel):</Text>
          <Box marginTop={1}>
            <Text color={colors.approval.header}>&gt; </Text>
            <PasteAwareTextInput
              value={otherText}
              onChange={setOtherText}
              onSubmit={handleOtherSubmit}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {optionsWithOther.map((option, index) => {
            const isSelected = index === selectedOption;
            const isChecked = selectedMulti.has(index);
            const color = isSelected ? colors.approval.header : undefined;

            return (
              <Box
                key={option.label}
                flexDirection="column"
                marginBottom={index < optionsWithOther.length - 1 ? 1 : 0}
              >
                <Box flexDirection="row">
                  <Box width={2} flexShrink={0}>
                    <Text color={color}>{isSelected ? ">" : " "}</Text>
                  </Box>
                  {currentQuestion.multiSelect &&
                    index < optionsWithOther.length - 1 && (
                      <Box width={4} flexShrink={0}>
                        <Text color={color}>[{isChecked ? "x" : " "}]</Text>
                      </Box>
                    )}
                  <Box flexGrow={1}>
                    <Text color={color} bold={isSelected}>
                      {index + 1}. {option.label}
                    </Text>
                  </Box>
                </Box>
                {option.description && (
                  <Box paddingLeft={currentQuestion.multiSelect ? 6 : 2}>
                    <Text dimColor>{option.description}</Text>
                  </Box>
                )}
              </Box>
            );
          })}

          <Box marginTop={1}>
            <Text dimColor>
              {currentQuestion.multiSelect
                ? "Space to toggle, Enter to confirm selection"
                : `Enter to select, or type 1-${optionsWithOther.length}`}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
});

QuestionDialog.displayName = "QuestionDialog";
