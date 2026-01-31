import { memo } from "react";
import { Text } from "./Text";

type ErrorLine = {
  kind: "error";
  id: string;
  text: string;
};

export const ErrorMessage = memo(({ line }: { line: ErrorLine }) => {
  return <Text>{line.text}</Text>;
});
