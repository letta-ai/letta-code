import { memo } from "react";
import { Text } from "./Text";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

export const UserMessage = memo(({ line }: { line: UserLine }) => {
  return <Text>{`> ${line.text}`}</Text>;
});
