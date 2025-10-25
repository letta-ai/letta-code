import chalk from "chalk";
import { Text } from "ink";
import type React from "react";
import { colors } from "./colors.js";

interface ShimmerTextProps {
  color?: string;
  message: string;
  shimmerOffset: number;
}

export const ShimmerText: React.FC<ShimmerTextProps> = ({
  color = colors.status.processing,
  message,
  shimmerOffset,
}) => {
  const fullText = `${message}…`;

  // Create the shimmer effect - simple 3-char highlight
  const shimmerText = fullText
    .split("")
    .map((char, i) => {
      // Check if this character is within the 3-char shimmer window
      const isInShimmer = i >= shimmerOffset && i < shimmerOffset + 3;

      if (isInShimmer) {
        return chalk.hex(colors.status.processingShimmer)(char);
      }
      return chalk.hex(color)(char);
    })
    .join("");

  return <Text>{shimmerText}</Text>;
};
