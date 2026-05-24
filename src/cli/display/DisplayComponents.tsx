import { Box, type BoxProps } from "ink";
import { Text } from "@/cli/components/Text";

export { Box, Text };
export type { BoxProps };

export function Spacer() {
  return <Box flexGrow={1} />;
}
