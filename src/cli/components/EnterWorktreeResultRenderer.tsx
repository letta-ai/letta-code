import { Box } from "ink";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { Text } from "./Text";

const PREFIX_WIDTH = 5; // `  └  ` or `     `
const LABEL_WIDTH = 8;

export interface EnterWorktreeDisplayResult {
  path?: string;
  branch?: string;
  base?: string;
  switchedCwd?: boolean;
}

export function parseEnterWorktreeResult(
  text: string,
): EnterWorktreeDisplayResult | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const firstLine = normalized.split("\n").find((line) => line.trim());
  if (firstLine?.trim() !== "Created worktree.") {
    return null;
  }

  const field = (name: string): string | undefined => {
    const match = normalized.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim();
  };

  const result: EnterWorktreeDisplayResult = {
    path: field("Path"),
    branch: field("Branch"),
    base: field("Base"),
  };

  if (
    normalized.includes(
      "This conversation's working directory is now the new worktree.",
    )
  ) {
    result.switchedCwd = true;
  } else if (
    normalized.includes(
      "The conversation working directory was left unchanged.",
    )
  ) {
    result.switchedCwd = false;
  }

  if (!result.path && !result.branch && !result.base) {
    return null;
  }

  return result;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - PREFIX_WIDTH);
  const valueWidth = Math.max(0, contentWidth - LABEL_WIDTH);

  return (
    <Box flexDirection="row">
      <Box width={PREFIX_WIDTH} flexShrink={0}>
        <Text>{" ".repeat(PREFIX_WIDTH)}</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth} flexDirection="row">
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text dimColor>{label}:</Text>
        </Box>
        <Box flexGrow={1} width={valueWidth}>
          <Text wrap="truncate-end">{value}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function EnterWorktreeResultRenderer({
  resultText,
}: {
  resultText: string;
}) {
  const parsed = parseEnterWorktreeResult(resultText);
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - PREFIX_WIDTH);

  if (!parsed) {
    return null;
  }

  const cwdStatus =
    parsed.switchedCwd === undefined
      ? undefined
      : parsed.switchedCwd
        ? "switched to worktree"
        : "unchanged";

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={PREFIX_WIDTH} flexShrink={0}>
          <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text>Created worktree</Text>
        </Box>
      </Box>
      {parsed.path ? <DetailRow label="Path" value={parsed.path} /> : null}
      {parsed.branch ? (
        <DetailRow label="Branch" value={parsed.branch} />
      ) : null}
      {parsed.base ? <DetailRow label="Base" value={parsed.base} /> : null}
      {cwdStatus ? <DetailRow label="CWD" value={cwdStatus} /> : null}
    </Box>
  );
}
