import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

interface FeedbackDialogProps {
  onSubmit: (message: string) => void;
  onCancel: () => void;
}

export function FeedbackDialog({ onSubmit, onCancel }: FeedbackDialogProps) {
  const [feedbackText, setFeedbackText] = useState("");
  const [error, setError] = useState("");

  useInput((input, key) => {
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
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text color={colors.approval.header} bold>
          Send Feedback to Letta Team
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          Share your thoughts, report issues, or suggest improvements.
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text>Enter your feedback:</Text>
        </Box>
        <Box>
          <Text color={colors.approval.header}>&gt; </Text>
          <PasteAwareTextInput
            value={feedbackText}
            onChange={setFeedbackText}
            onSubmit={handleSubmit}
            placeholder="Type your feedback here..."
          />
        </Box>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box>
        <Text dimColor>Press Enter to submit • Esc to cancel</Text>
      </Box>
    </Box>
  );
}
