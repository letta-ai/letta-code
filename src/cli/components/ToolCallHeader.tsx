import { Box } from "ink";
import { Fragment, type ReactNode } from "react";
import { BlinkDot } from "./BlinkDot";
import { colors } from "./colors";
import { Text } from "./Text";

/** Colorize ordinary argument summaries using the existing shell palette. */
export function colorizeArgs(argsStr: string): ReactNode {
  if (!argsStr) return null;

  const palette = colors.shellSyntax;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  // Paths, filenames, labels, then standalone numbers.
  const re =
    /([\w.*?\-@~/]+\/[\w.*?\-@~/]*)|((?<=[(\s,])[\w.-]+\.\w{1,5}(?=[)\s,]|$))|(\w+)(?=\s*:)|(\b\d+\b)/g;

  for (let m = re.exec(argsStr); m !== null; m = re.exec(argsStr)) {
    if (m.index > lastIndex) {
      parts.push(
        <Fragment key={key++}>{argsStr.slice(lastIndex, m.index)}</Fragment>,
      );
    }
    const color = m[1]
      ? palette.string
      : m[2]
        ? palette.string
        : m[3]
          ? palette.comment
          : palette.number;
    parts.push(
      <Text key={key++} color={color}>
        {m[0]}
      </Text>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < argsStr.length) {
    parts.push(<Fragment key={key++}>{argsStr.slice(lastIndex)}</Fragment>);
  }
  return <>{parts}</>;
}

/** The ordinary tool row's dot, name, and argument wrapping, shared by sends. */
export function ToolCallHeader({
  name,
  args,
  shellArgs,
  columns,
  phase,
  resultOk,
  isStreaming,
  isMemory,
}: {
  name: string;
  args?: ReactNode;
  shellArgs?: ReactNode;
  columns: number;
  phase: "streaming" | "ready" | "running" | "finished";
  resultOk?: boolean;
  isStreaming?: boolean;
  isMemory?: boolean;
}) {
  const rightWidth = Math.max(0, columns - 2);
  const dotColor =
    phase === "streaming"
      ? colors.tool.streaming
      : phase === "ready"
        ? colors.tool.pending
        : phase === "running"
          ? colors.tool.running
          : resultOk === false
            ? colors.tool.error
            : colors.tool.completed;
  const nameColor = isMemory ? colors.tool.memoryName : undefined;

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <BlinkDot
          color={dotColor}
          shouldAnimate={
            phase === "running" || (phase === "ready" && !isStreaming)
          }
        />
        <Text></Text>
      </Box>
      <Box flexGrow={1} width={rightWidth}>
        {name.length >= rightWidth ? (
          <Text wrap="wrap">
            <Text bold color={nameColor}>
              {name}{" "}
            </Text>
            {args}
          </Text>
        ) : (
          <Box flexDirection="row">
            <Text bold color={nameColor}>
              {name}{" "}
            </Text>
            {shellArgs || args ? (
              <Box
                flexGrow={1}
                width={Math.max(0, rightWidth - name.length - 1)}
              >
                {shellArgs ? (
                  <Text color={colors.shellSyntax.text}>{shellArgs}</Text>
                ) : (
                  <Text wrap="wrap">{args}</Text>
                )}
              </Box>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}
