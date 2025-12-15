import { Box } from "ink";
import { AgentInfoBar } from "./AgentInfoBar";
import { FileAutocomplete } from "./FileAutocomplete";
import { SlashCommandAutocomplete } from "./SlashCommandAutocomplete";

interface InputAssistProps {
  currentInput: string;
  cursorPosition: number;
  onFileSelect: (path: string) => void;
  onCommandSelect: (command: string) => void;
  onAutocompleteActiveChange: (isActive: boolean) => void;
  agentId?: string;
  agentName?: string | null;
  serverUrl?: string;
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
  onAutocompleteActiveChange,
  agentId,
  agentName,
  serverUrl,
}: InputAssistProps) {
  // Show file autocomplete when @ is present
  if (currentInput.includes("@")) {
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
  if (currentInput.startsWith("/")) {
    return (
      <Box flexDirection="column">
        <SlashCommandAutocomplete
          currentInput={currentInput}
          cursorPosition={cursorPosition}
          onSelect={onCommandSelect}
          onActiveChange={onAutocompleteActiveChange}
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
