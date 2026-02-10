import { memo } from "react";
import { Text } from "./Text";

type ReasoningLine = {
  kind: "reasoning";
  id: string;
  text: string;
  phase: "streaming" | "finished";
};

export const ReasoningMessage = memo(({ line }: { line: ReasoningLine }) => {
  return <Text dimColor>{line.text}</Text>;
});
