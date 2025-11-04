import { Box, Text } from "ink";
import Link from "ink-link";
import { commands } from "../commands/registry";
import { colors } from "./colors";

// Compute command list once at module level since it never changes
const commandList = Object.entries(commands).map(([cmd, { desc }]) => ({
  cmd,
  desc,
}));

export function CommandPreview({
  currentInput,
  agentId,
  serverUrl,
}: {
  currentInput: string;
  agentId?: string;
  serverUrl?: string;
}) {
  if (!currentInput.startsWith("/")) {
    return null;
  }

  // Show agent URL only for cloud users
  const showAgentUrl =
    agentId && agentId !== "loading" && serverUrl?.includes("api.letta.com");

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.command.border}
      paddingX={1}
    >
      {commandList.map((item) => (
        <Box key={item.cmd} justifyContent="space-between" width={40}>
          <Text>{item.cmd}</Text>
          <Text dimColor>{item.desc}</Text>
        </Box>
      ))}
      {showAgentUrl && (
        <Box marginTop={1} paddingTop={1} borderTop borderColor="gray">
          <Link url={`https://app.letta.com/agents/${agentId}`}>
            <Text dimColor>View agent:</Text>
          </Link>
        </Box>
      )}
    </Box>
  );
}
