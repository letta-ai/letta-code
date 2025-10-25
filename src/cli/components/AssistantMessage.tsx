import { Text } from "ink";
import { memo } from "react";

type AssistantLine = {
  kind: "assistant";
  id: string;
  text: string;
  phase: "streaming" | "finished";
};

export const AssistantMessage = memo(({ line }: { line: AssistantLine }) => {
  return <Text>{line.text}</Text>;
});
