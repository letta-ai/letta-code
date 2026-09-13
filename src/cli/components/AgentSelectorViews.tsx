import { Box } from "ink";
import type { ReactElement } from "react";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { Text } from "./Text";

interface CloudLoginPromptProps {
  loginCommand: string;
}

interface AgentDeleteConfirmOverlayProps {
  command: string;
  displayName: string;
  input: string;
  loading: boolean;
}

export function CloudLoginPrompt({
  loginCommand,
}: CloudLoginPromptProps): ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text dimColor>Sign in with Letta to see your agents here.</Text>
      <Box height={1} />
      <Box flexDirection="column">
        <Text
          color={colors.selector.itemHighlighted}
        >{`> ${loginCommand}`}</Text>
        <Box paddingLeft={2}>
          <Text dimColor>Sign in with Letta</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function AgentDeleteConfirmOverlay({
  command,
  displayName,
  input,
  loading,
}: AgentDeleteConfirmOverlayProps): ReactElement {
  const inputMatches = input === displayName;
  let footerText = "Esc cancel";
  if (loading) {
    footerText = "Deleting... · Esc cancel";
  } else if (inputMatches) {
    footerText = "Enter to delete · Esc cancel";
  }

  return (
    <OverlayShell command={command} title="Delete agent">
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          {"  "}Are you sure you want to delete <Text bold>{displayName}</Text>?
        </Text>
        <Text color="red">{"  "}This action can not be undone.</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
        <Text dimColor={!input}>{input || "(type the agent's name)"}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {"  "}
          {footerText}
        </Text>
      </Box>
    </OverlayShell>
  );
}
