import { Box, Text } from "ink";
import Link from "ink-link";
import { useMemo } from "react";
import { settingsManager } from "../../settings-manager";
import { colors } from "./colors";
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
 * Shows agent info bar below slash command autocomplete
 */
function AgentInfoBar({
  agentId,
  agentName,
  serverUrl,
}: {
  agentId?: string;
  agentName?: string | null;
  serverUrl?: string;
}) {
  // Check if current agent is pinned
  const isPinned = useMemo(() => {
    if (!agentId) return false;
    const localPinned = settingsManager.getLocalPinnedAgents();
    const globalPinned = settingsManager.getGlobalPinnedAgents();
    return localPinned.includes(agentId) || globalPinned.includes(agentId);
  }, [agentId]);

  const isCloudUser = serverUrl?.includes("api.letta.com");
  const showBottomBar = agentId && agentId !== "loading";

  if (!showBottomBar) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.command.border}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text color="gray">Current agent: </Text>
        <Text bold>{agentName || "Unnamed"}</Text>
        {isPinned ? (
          <Text color="green"> (pinned ✓)</Text>
        ) : (
          <Text color="gray"> (type /pin to pin agent)</Text>
        )}
      </Box>
      <Box>
        <Text dimColor>{agentId}</Text>
        {isCloudUser && (
          <>
            <Text dimColor> · </Text>
            <Link url={`https://app.letta.com/agents/${agentId}`}>
              <Text color={colors.link.text}>Open in ADE ↗</Text>
            </Link>
            <Text dimColor> · </Text>
            <Link url="https://app.letta.com/settings/organization/usage">
              <Text color={colors.link.text}>View usage ↗</Text>
            </Link>
          </>
        )}
        {!isCloudUser && <Text dimColor> · {serverUrl}</Text>}
      </Box>
    </Box>
  );
}

/**
 * Wrapper for slash command mode - shows autocomplete + agent info
 */
function SlashCommandAssist({
  currentInput,
  cursorPosition,
  onCommandSelect,
  onAutocompleteActiveChange,
  agentId,
  agentName,
  serverUrl,
}: {
  currentInput: string;
  cursorPosition: number;
  onCommandSelect: (command: string) => void;
  onAutocompleteActiveChange: (isActive: boolean) => void;
  agentId?: string;
  agentName?: string | null;
  serverUrl?: string;
}) {
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
      <SlashCommandAssist
        currentInput={currentInput}
        cursorPosition={cursorPosition}
        onCommandSelect={onCommandSelect}
        onAutocompleteActiveChange={onAutocompleteActiveChange}
        agentId={agentId}
        agentName={agentName}
        serverUrl={serverUrl}
      />
    );
  }

  // No assistance needed
  return null;
}
