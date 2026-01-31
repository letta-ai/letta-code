import { Box } from "ink";
import { Text } from "./Text";

export type Row =
  | { kind: "user"; text: string; id?: string }
  | { kind: "assistant"; text: string; id?: string }
  | { kind: "reasoning"; text: string; id?: string };

export function Transcript({ rows }: { rows: Row[] }) {
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => {
        if (r.kind === "user")
          return <Text key={r.id ?? i}>{`> ${r.text}`}</Text>;
        if (r.kind === "assistant")
          return <Text key={r.id ?? i}>{r.text}</Text>;
        return (
          <Text key={r.id ?? i} dimColor>
            {r.text}
          </Text>
        ); // reasoning
      })}
    </Box>
  );
}
