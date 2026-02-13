import { memo } from "react";
import { Text } from "./Text";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

export const UserMessage = memo(
  ({ line, prompt }: { line: UserLine; prompt?: string }) => {
    return <Text>{`${prompt || ">"} ${line.text}`}</Text>;
  },
);
