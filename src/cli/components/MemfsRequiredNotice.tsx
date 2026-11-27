import { Box, useInput } from "ink";
import { Text } from "./Text";

export function MemfsRequiredNotice({ onClose }: { onClose: () => void }) {
  useInput(() => onClose());
  return (
    <Box flexDirection="column">
      <Text>The memory viewer requires memfs. Run /memfs enable first.</Text>
      <Text dimColor>Press any key to dismiss</Text>
    </Box>
  );
}
