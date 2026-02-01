import { Box, useInput } from "ink";
import { useState } from "react";
import { DEFAULT_AGENT_NAME } from "../../constants";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { Text } from "./Text";

interface PinDialogProps {
  currentName: string;
  local: boolean;
  onSubmit: (newName: string | null) => void; // null means keep current name
  onCancel: () => void;
}

/**
 * Validate agent name against backend rules.
 * Matches: Unicode letters, digits, underscores, spaces, hyphens, apostrophes
 * Blocks: / \ : * ? " < > |
 */
export function validateAgentName(name: string): string | null {
  if (!name || !name.trim()) {
    return "Name cannot be empty";
  }

  const trimmed = name.trim();

  // Match backend regex: ^[\w '-]+$ with unicode
  // \w matches Unicode letters, digits, and underscores
  // We also allow spaces, hyphens, and apostrophes
  const validPattern = /^[\w '-]+$/u;

  if (!validPattern.test(trimmed)) {
    return "Name contains invalid characters. Only letters, digits, spaces, hyphens, underscores, and apostrophes are allowed.";
  }

  if (trimmed.length > 100) {
    return "Name is too long (max 100 characters)";
  }

  return null;
}

/**
 * Check if the name is the default Letta Code agent name.
 */
export function isDefaultAgentName(name: string): boolean {
  return name === DEFAULT_AGENT_NAME;
}

export function PinDialog({
  currentName,
  local,
  onSubmit,
  onCancel,
}: PinDialogProps) {
  const isDefault = isDefaultAgentName(currentName);
  const [mode, setMode] = useState<"choose" | "input">(
    isDefault ? "input" : "choose",
  );
  const [nameInput, setNameInput] = useState("");
  const [selectedOption, setSelectedOption] = useState(0);
  const [error, setError] = useState("");

  const scopeText = local ? "to this project" : "globally";

  useInput((input, key) => {
    // CTRL-C: immediately cancel (bypasses mode transitions)
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      if (mode === "input" && !isDefault) {
        // Go back to choose mode
        setMode("choose");
        setError("");
      } else {
        onCancel();
      }
      return;
    }

    if (mode === "choose") {
      if (input === "j" || key.downArrow) {
        setSelectedOption((prev) => Math.min(prev + 1, 1));
      } else if (input === "k" || key.upArrow) {
        setSelectedOption((prev) => Math.max(prev - 1, 0));
      } else if (key.return) {
        if (selectedOption === 0) {
          // Keep current name
          onSubmit(null);
        } else {
          // Change name
          setMode("input");
        }
      }
    }
  });

  const handleNameSubmit = (text: string) => {
    const trimmed = text.trim();
    const validationError = validateAgentName(trimmed);

    if (validationError) {
      setError(validationError);
      return;
    }

    onSubmit(trimmed);
  };

  // Input-only mode for default names
  if (isDefault || mode === "input") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text color={colors.approval.header} bold>
            {isDefault ? "Name your agent" : "Rename your agent"}
          </Text>
        </Box>

        {isDefault && (
          <Box marginBottom={1}>
            <Text dimColor>
              Give your agent a memorable name before pinning {scopeText}.
            </Text>
          </Box>
        )}

        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text>Enter a name:</Text>
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
              placeholder={isDefault ? "e.g., my-coding-agent" : currentName}
            />
          </Box>
        </Box>

        {error && (
          <Box marginBottom={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        <Box>
          <Text dimColor>
            Press Enter to confirm {!isDefault && "• Esc to go back"}
            {isDefault && "• Esc to cancel"}
          </Text>
        </Box>
      </Box>
    );
  }

  // Choice mode for custom names
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text color={colors.approval.header} bold>
          Pin agent {scopeText}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          Would you like to keep the current name or change it?
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {[
          { label: `Keep name "${currentName}"`, value: "keep" },
          { label: "Change name", value: "change" },
        ].map((option, index) => {
          const isSelected = index === selectedOption;
          return (
            <Box key={option.value} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color={isSelected ? colors.approval.header : undefined}>
                  {isSelected ? ">" : " "}
                </Text>
              </Box>
              <Text color={isSelected ? colors.approval.header : undefined}>
                {index + 1}. {option.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box>
        <Text dimColor>↑↓/jk to select • Enter to confirm • Esc to cancel</Text>
      </Box>
    </Box>
  );
}
