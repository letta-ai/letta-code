import { Box } from "ink";
import { useEffect } from "react";
import type { ModelReasoningEffort } from "@/agent/model";
import { AgentInfoBar } from "./AgentInfoBar";
import { FileAutocomplete } from "./FileAutocomplete";
import { SlashCommandAutocomplete } from "./SlashCommandAutocomplete";
import type {
  ModCommandAutocompleteItem,
  SessionCompletions,
} from "./types/autocomplete";

interface InputAssistProps {
  currentInput: string;
  session?: SessionCompletions;
  cursorPosition: number;
  fdPath?: string | null;
  onFileAutocompleteApply: (value: string, cursorPosition: number) => void;
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
  modCommands?: Record<string, ModCommandAutocompleteItem>;
}

export function InputAssist({
  currentInput,
  session,
  cursorPosition,
  fdPath,
  onFileAutocompleteApply,
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
  modCommands,
}: InputAssistProps) {
  const showFileAutocomplete = currentInput.includes("@");
  const showCommandAutocomplete =
    !showFileAutocomplete && currentInput.startsWith("/");

  useEffect(() => {
    if (!showFileAutocomplete && !showCommandAutocomplete) {
      onAutocompleteActiveChange(false);
    }
  }, [
    showFileAutocomplete,
    showCommandAutocomplete,
    onAutocompleteActiveChange,
  ]);

  if (showFileAutocomplete) {
    return (
      <FileAutocomplete
        currentInput={currentInput}
        cursorPosition={cursorPosition}
        fdPath={fdPath}
        searchFiles={session?.searchFiles}
        onApplyCompletion={onFileAutocompleteApply}
        onActiveChange={onAutocompleteActiveChange}
        workingDirectory={workingDirectory}
      />
    );
  }

  if (showCommandAutocomplete) {
    return (
      <Box flexDirection="column">
        <SlashCommandAutocomplete
          currentInput={currentInput}
          session={session}
          cursorPosition={cursorPosition}
          onSelect={onCommandSelect}
          onAutocomplete={onCommandAutocomplete}
          onActiveChange={onAutocompleteActiveChange}
          agentId={agentId}
          workingDirectory={workingDirectory}
          modCommands={modCommands}
        />
        {!session && (
          <AgentInfoBar
            agentId={agentId}
            agentName={agentName}
            currentModel={currentModel}
            currentReasoningEffort={currentReasoningEffort}
            serverUrl={serverUrl}
            conversationId={conversationId}
          />
        )}
      </Box>
    );
  }

  return null;
}
