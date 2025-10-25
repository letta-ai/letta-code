import { Box, Text } from "ink";
import { commands } from "../commands/registry";
import { colors } from "./colors";

// Compute command list once at module level since it never changes
const commandList = Object.entries(commands).map(([cmd, { desc }]) => ({
  cmd,
  desc,
}));

export function CommandPreview({ currentInput }: { currentInput: string }) {
  if (!currentInput.startsWith("/")) {
    return null;
  }

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
    </Box>
  );
}
