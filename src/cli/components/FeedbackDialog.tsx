import { Box, useInput } from "ink";
import { useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { Text } from "./Text";

const SOLID_LINE = "─";

interface FeedbackDialogProps {
  onSubmit: (message: string) => void;
  onCancel: () => void;
  initialValue?: string;
}

export function FeedbackDialog({
  onSubmit,
  onCancel,
  initialValue = "",
}: FeedbackDialogProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  const [feedbackText, setFeedbackText] = useState(initialValue);
  const [error, setError] = useState("");

  useInput((_input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && _input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      onCancel();
    }
  });

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Feedback message cannot be empty");
      return;
    }
    if (trimmed.length > 10000) {
      setError("Feedback message is too long (max 10,000 characters)");
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /feedback"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Box flexDirection="column" marginBottom={1}>
        <Text>{"  "}Enter your feedback:</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
        <PasteAwareTextInput
          value={feedbackText}
          onChange={setFeedbackText}
          onSubmit={handleSubmit}
          placeholder="(type your feedback)"
        />
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">
            {"  "}
            {error}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter to submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
