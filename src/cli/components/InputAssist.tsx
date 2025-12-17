import { Box } from "ink";
import { useEffect } from "react";
import { AgentInfoBar } from "./AgentInfoBar";
import { FileAutocomplete } from "./FileAutocomplete";
import { SlashCommandAutocomplete } from "./SlashCommandAutocomplete";

interface InputAssistProps {
  currentInput: string;
  cursorPosition: number;
  onFileSelect: (path: string) => void;
  onCommandSelect: (command: string) => void;
  onCommandAutocomplete: (command: string) => void;
  onAutocompleteActiveChange: (isActive: boolean) => void;
  agentId?: string;
  agentName?: string | null;
  serverUrl?: string;
  workingDirectory?: string;
}

/**
 * Shows contextual assistance below the input:
 * - File autocomplete when "@" is detected
 * - Slash command autocomplete when "/" is detected
 * - Nothing otherwise
 */
export function InputAssist({
  currentInput,
  cursorPosition,
  onFileSelect,
  onCommandSelect,
  onCommandAutocomplete,
  onAutocompleteActiveChange,
  agentId,
  agentName,
  serverUrl,
  workingDirectory,
}: InputAssistProps) {
  const showFileAutocomplete = currentInput.includes("@");
  const showCommandAutocomplete =
    !showFileAutocomplete && currentInput.startsWith("/");

  // Reset active state when no autocomplete is being shown
  useEffect(() => {
    if (!showFileAutocomplete && !showCommandAutocomplete) {
      onAutocompleteActiveChange(false);
    }
  }, [
    showFileAutocomplete,
    showCommandAutocomplete,
    onAutocompleteActiveChange,
  ]);

  // Show file autocomplete when @ is present
  if (showFileAutocomplete) {
    return (
      <FileAutocomplete
        currentInput={currentInput}
        cursorPosition={cursorPosition}
        onSelect={onFileSelect}
        onActiveChange={onAutocompleteActiveChange}
      />
    );
  }

  // Show slash command autocomplete when input starts with /
  if (showCommandAutocomplete) {
    return (
      <Box flexDirection="column">
        <SlashCommandAutocomplete
          currentInput={currentInput}
          cursorPosition={cursorPosition}
          onSelect={onCommandSelect}
          onAutocomplete={onCommandAutocomplete}
          onActiveChange={onAutocompleteActiveChange}
          agentId={agentId}
          workingDirectory={workingDirectory}
        />
        <AgentInfoBar
          agentId={agentId}
          agentName={agentName}
          serverUrl={serverUrl}
        />
      </Box>
    );
  }

  // No assistance needed
  return null;
}
