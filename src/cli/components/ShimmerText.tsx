import chalk from "chalk";
import { memo } from "react";
import { colors } from "./colors.js";
import { Text } from "./Text";

interface ShimmerTextProps {
  color?: string;
  boldPrefix?: string;
  message: string;
  shimmerOffset: number;
}

export const ShimmerText = memo(function ShimmerText({
  color = colors.status.processing,
  boldPrefix,
  message,
  shimmerOffset,
}: ShimmerTextProps) {
  const fullText = `${boldPrefix ? `${boldPrefix} ` : ""}${message}…`;
  const prefixLength = boldPrefix ? boldPrefix.length + 1 : 0; // +1 for space

  // Create the shimmer effect - simple 3-char highlight
  const shimmerText = fullText
    .split("")
    .map((char, i) => {
      // Check if this character is within the 3-char shimmer window
      const isInShimmer = i >= shimmerOffset && i < shimmerOffset + 3;
      const isInPrefix = i < prefixLength;

      if (isInShimmer) {
        const styledChar = chalk.hex(colors.status.processingShimmer)(char);
        return isInPrefix ? chalk.bold(styledChar) : styledChar;
      }
      const styledChar = chalk.hex(color)(char);
      return isInPrefix ? chalk.bold(styledChar) : styledChar;
    })
    .join("");

  return <Text>{shimmerText}</Text>;
});
