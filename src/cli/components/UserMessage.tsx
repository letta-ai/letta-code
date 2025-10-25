import { Text } from "ink";
import { memo } from "react";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

export const UserMessage = memo(({ line }: { line: UserLine }) => {
  return <Text>{`> ${line.text}`}</Text>;
});
