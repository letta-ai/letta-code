import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { DEFAULT_AGENT_NAME } from "../../constants";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { validateAgentName } from "./PinDialog";

// Horizontal line character (matches other selectors)
const SOLID_LINE = "─";

interface NewAgentDialogProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function NewAgentDialog({ onSubmit, onCancel }: NewAgentDialogProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

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
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /new"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title */}
      <Text bold color={colors.selector.title}>
        Create new agent
      </Text>

      <Box height={1} />

      {/* Description */}
      <Box paddingLeft={2}>
        <Text dimColor>
          Enter a name for your new agent, or press Enter for default.
        </Text>
      </Box>

      <Box height={1} />

      {/* Input field */}
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>Agent name:</Text>
        <Box>
          <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
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
        <Box paddingLeft={2} marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box height={1} />

      {/* Footer hints */}
      <Box paddingLeft={2}>
        <Text dimColor>Enter create · Esc cancel</Text>
      </Box>
    </Box>
  );
}
