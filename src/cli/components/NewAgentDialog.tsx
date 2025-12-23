import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { DEFAULT_AGENT_NAME } from "../../constants";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { validateAgentName } from "./PinDialog";

interface NewAgentDialogProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function NewAgentDialog({ onSubmit, onCancel }: NewAgentDialogProps) {
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");

  useInput((_, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const handleNameSubmit = (text: string) => {
    const trimmed = text.trim();

    // Empty input = use default name
    if (!trimmed) {
      onSubmit(DEFAULT_AGENT_NAME);
      return;
    }

    const validationError = validateAgentName(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }

    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text color={colors.approval.header} bold>
          Create new agent
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          Enter a name for your new agent, or press Enter for default.
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text>Agent name:</Text>
        </Box>
        <Box>
          <Text color={colors.approval.header}>&gt; </Text>
          <PasteAwareTextInput
            value={nameInput}
            onChange={(val) => {
              setNameInput(val);
              setError("");
            }}
            onSubmit={handleNameSubmit}
            placeholder={DEFAULT_AGENT_NAME}
          />
        </Box>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box>
        <Text dimColor>Press Enter to create • Esc to cancel</Text>
      </Box>
    </Box>
  );
}
