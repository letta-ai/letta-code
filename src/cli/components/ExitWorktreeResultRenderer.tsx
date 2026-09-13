import { Box } from "ink";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { Text } from "./Text";

const PREFIX_WIDTH = 5; // `  └  ` or `     `
const LABEL_WIDTH = 8;

export interface ExitWorktreeDisplayResult {
  action: "removed" | "left";
  path?: string;
  branch?: string;
  lock?: string;
  cwd?: string;
  switchedCwd?: boolean;
}

export function parseExitWorktreeResult(
  text: string,
): ExitWorktreeDisplayResult | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const firstLine = normalized.split("\n").find((line) => line.trim());
  const action =
    firstLine?.trim() === "Removed worktree."
      ? "removed"
      : firstLine?.trim() === "Left worktree."
        ? "left"
        : null;
  if (!action) {
    return null;
  }

  const field = (name: string): string | undefined => {
    const match = normalized.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim();
  };

  const result: ExitWorktreeDisplayResult = {
    action,
    path: field("Path"),
    branch: field("Branch"),
    lock: field("Lock"),
    cwd: field("CWD"),
  };

  if (
    normalized.includes(
      "This conversation's working directory is now the primary checkout.",
    )
  ) {
    result.switchedCwd = true;
  } else if (
    normalized.includes("The working directory could not be switched")
  ) {
    result.switchedCwd = false;
  }

  if (!result.path && !result.branch && !result.cwd) {
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

export function ExitWorktreeResultRenderer({
  resultText,
}: {
  resultText: string;
}) {
  const parsed = parseExitWorktreeResult(resultText);
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - PREFIX_WIDTH);

  if (!parsed) {
    return null;
  }

  // Only surface the CWD row when the switch succeeded. A failed switch is the
  // one case worth spelling out, because the session is somewhere unexpected.
  const cwdValue =
    parsed.switchedCwd === false
      ? "⚠ not switched"
      : (parsed.cwd ?? "primary checkout");

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={PREFIX_WIDTH} flexShrink={0}>
          <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text>
            {parsed.action === "removed"
              ? "Removed worktree"
              : "Left worktree (kept on disk)"}
          </Text>
        </Box>
      </Box>
      {parsed.path ? <DetailRow label="Path" value={parsed.path} /> : null}
      {parsed.branch ? (
        <DetailRow label="Branch" value={parsed.branch} />
      ) : null}
      {parsed.lock ? <DetailRow label="Lock" value={parsed.lock} /> : null}
      <DetailRow label="CWD" value={cwdValue} />
    </Box>
  );
}
