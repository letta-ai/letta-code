import { Box, Text } from "ink";
import Link from "ink-link";
import { useMemo } from "react";
import { getProfiles } from "../commands/profile";
import { commands } from "../commands/registry";
import { colors } from "./colors";

// Compute command list once at module level since it never changes
// Filter out hidden commands
const commandList = Object.entries(commands)
  .filter(([, { hidden }]) => !hidden)
  .map(([cmd, { desc }]) => ({
    cmd,
    desc,
  }))
  .sort((a, b) => a.cmd.localeCompare(b.cmd));

export function CommandPreview({
  currentInput,
  agentId,
  agentName,
  serverUrl,
}: {
  currentInput: string;
  agentId?: string;
  agentName?: string | null;
  serverUrl?: string;
}) {
  // Look up if current agent is saved as a profile
  const profileName = useMemo(() => {
    if (!agentId) return null;
    const profiles = getProfiles();
    for (const [name, id] of Object.entries(profiles)) {
      if (id === agentId) return name;
    }
    return null;
  }, [agentId]);

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
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text dimColor>Current agent: </Text>
            <Text bold>{agentName || "Unnamed"}</Text>
            {profileName ? (
              <Text color="green"> (profile: {profileName} ✓)</Text>
            ) : (
              <Text dimColor> (type /profile to pin agent)</Text>
            )}
          </Text>
          <Box>
            <Text dimColor>{agentId}</Text>
            {isCloudUser && (
              <>
                <Text dimColor> · </Text>
                <Link url={`https://app.letta.com/agents/${agentId}`}>
                  <Text color={colors.link.text}>Open in ADE ↗</Text>
                </Link>
                <Text dimColor>· </Text>
                <Link url="https://app.letta.com/settings/organization/usage">
                  <Text color={colors.link.text}>View usage ↗</Text>
                </Link>
              </>
            )}
            {!isCloudUser && <Text dimColor> · {serverUrl}</Text>}
          </Box>
        </Box>
      )}
    </Box>
  );
}
