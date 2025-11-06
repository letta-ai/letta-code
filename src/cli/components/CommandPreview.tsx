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

  const isCloudUser = serverUrl?.includes("api.letta.com");
  const showBottomBar = agentId && agentId !== "loading";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.command.border}
      paddingX={1}
    >
      {commandList.map((item) => (
        <Box key={item.cmd}>
          <Text>
            {item.cmd.padEnd(15)} <Text dimColor>{item.desc}</Text>
          </Text>
        </Box>
      ))}
      {showBottomBar && (
        <Box marginTop={1} paddingTop={1} borderTop borderColor="gray">
          {isCloudUser ? (
            <Link url={`https://app.letta.com/agents/${agentId}`}>
              <Text dimColor>View agent in ADE</Text>
            </Link>
          ) : (
            <Text dimColor>Connected to agent located at {serverUrl}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
