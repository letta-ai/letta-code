import { Text } from "ink";
import { memo } from "react";

type ErrorLine = {
  kind: "error";
  id: string;
  text: string;
};

export const ErrorMessage = memo(({ line }: { line: ErrorLine }) => {
  return <Text>{line.text}</Text>;
});
