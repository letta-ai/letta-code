import { Box } from "ink";
import { useEffect } from "react";
import type { ModelReasoningEffort } from "@/agent/model";
import { AgentInfoBar } from "./AgentInfoBar";
import { SlashCommandAutocomplete } from "./SlashCommandAutocomplete";
import type { ExtensionCommandAutocompleteItem } from "./types/autocomplete";

interface InputAssistProps {
  currentInput: string;
  cursorPosition: number;
  onCommandSelect: (command: string) => void;
  onCommandAutocomplete: (command: string) => void;
  onAutocompleteActiveChange: (isActive: boolean) => void;
  agentId?: string;
  agentName?: string | null;
  currentModel?: string | null;
  currentReasoningEffort?: ModelReasoningEffort | null;
  serverUrl?: string;
  workingDirectory?: string;
  conversationId?: string;
  extensionCommands?: Record<string, ExtensionCommandAutocompleteItem>;
}

/**
 * Shows contextual assistance below the input:
 * - Slash command autocomplete when "/" is detected
 * - Nothing otherwise
 *
 * File autocomplete is intentionally disabled while we replace the old
 * eager file indexer with an on-demand path search implementation.
 */
export function InputAssist({
  currentInput,
  cursorPosition,
  onCommandSelect,
  onCommandAutocomplete,
  onAutocompleteActiveChange,
  agentId,
  agentName,
  currentModel,
  currentReasoningEffort,
  serverUrl,
  workingDirectory,
  conversationId,
  extensionCommands,
}: InputAssistProps) {
  const showCommandAutocomplete = currentInput.startsWith("/");

  // Reset active state when no autocomplete is being shown
  useEffect(() => {
    if (!showCommandAutocomplete) {
      onAutocompleteActiveChange(false);
    }
  }, [showCommandAutocomplete, onAutocompleteActiveChange]);

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
          extensionCommands={extensionCommands}
        />
        <AgentInfoBar
          agentId={agentId}
          agentName={agentName}
          currentModel={currentModel}
          currentReasoningEffort={currentReasoningEffort}
          serverUrl={serverUrl}
          conversationId={conversationId}
        />
      </Box>
    );
  }

  // No assistance needed
  return null;
}
