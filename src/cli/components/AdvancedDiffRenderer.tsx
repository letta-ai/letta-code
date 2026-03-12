import { relative } from "node:path";
import { Box } from "ink";
import { useMemo } from "react";
import {
  ADV_DIFF_CONTEXT_LINES,
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
} from "../helpers/diff";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { EditRenderer, MultiEditRenderer, WriteRenderer } from "./DiffRenderer";
import {
  highlightCode,
  languageFromPath,
  type StyledSpan,
} from "./SyntaxHighlightedCommand";
import { Text } from "./Text";

type EditItem = {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

type Props =
  | {
      kind: "write";
      filePath: string;
      content: string;
      showHeader?: boolean;
      oldContentOverride?: string;
    }
  | {
      kind: "edit";
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
      showHeader?: boolean;
      oldContentOverride?: string;
    }
  | {
      kind: "multi_edit";
      filePath: string;
      edits: EditItem[];
      showHeader?: boolean;
      oldContentOverride?: string;
    };

function formatRelativePath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  return relativePath.startsWith("..") ? relativePath : `./${relativePath}`;
}

function padLeft(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

// A styled text chunk with optional color/dim for row-splitting.
type StyledChunk = { text: string; color?: string; dimColor?: boolean };

// Split styled chunks into rows of exactly `cols` characters, padding the last row.
// Continuation rows start with a blank indent of `contIndent` characters
// (matching Codex's empty-gutter + 2-space continuation, diff_render.rs:922-929).
function buildPaddedRows(
  chunks: StyledChunk[],
  cols: number,
  contIndent: number,
): StyledChunk[][] {
  if (cols <= 0) return [chunks];
  const rows: StyledChunk[][] = [];
  let row: StyledChunk[] = [];
  let len = 0;
  for (const chunk of chunks) {
    let rem = chunk.text;
    while (rem.length > 0) {
      const space = cols - len;
      if (rem.length <= space) {
        row.push({ text: rem, color: chunk.color, dimColor: chunk.dimColor });
        len += rem.length;
        rem = "";
      } else {
        row.push({
          text: rem.slice(0, space),
          color: chunk.color,
          dimColor: chunk.dimColor,
        });
        rows.push(row);
        // Start continuation row with blank gutter indent
        row = [{ text: " ".repeat(contIndent) }];
        len = contIndent;
        rem = rem.slice(space);
      }
    }
  }
  if (len < cols) row.push({ text: " ".repeat(cols - len) });
  if (row.length > 0) rows.push(row);
  return rows;
}

// Render a single diff line split into full-width rows.
// Each visual row gets its own <Text> with backgroundColor so there are no gaps.
// See ~/dev/codex/codex-rs/tui/src/diff_render.rs lines 836-936.
function Line({
  kind,
  displayNo,
  text,
  syntaxSpans,
  gutterWidth,
  columns,
  indent,
}: {
  kind: "context" | "remove" | "add";
  displayNo: number;
  text: string;
  syntaxSpans?: StyledSpan[];
  gutterWidth: number;
  columns: number;
  indent: string;
}) {
  const symbol = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
  const symbolColor =
    kind === "add"
      ? colors.diff.symbolAdd
      : kind === "remove"
        ? colors.diff.symbolRemove
        : colors.diff.symbolContext;
  const bgLine =
    kind === "add"
      ? colors.diff.addedLineBg
      : kind === "remove"
        ? colors.diff.removedLineBg
        : colors.diff.contextLineBg;

  // Build styled chunks: indent + gutter + sign + content
  const gutterStr = `${padLeft(displayNo, gutterWidth)} `;
  const chunks: StyledChunk[] = [];
  if (indent) chunks.push({ text: indent });
  chunks.push({ text: gutterStr, dimColor: kind === "context" });
  chunks.push({ text: symbol, color: symbolColor });
  chunks.push({ text: " " });
  if (syntaxSpans && syntaxSpans.length > 0) {
    for (const span of syntaxSpans) {
      chunks.push({ text: span.text, color: span.color });
    }
  } else {
    chunks.push({ text });
  }

  // Continuation indent = indent + gutter + sign + space (blank, same width)
  const contIndent = indent.length + gutterStr.length + 1 + 1;
  const rows = buildPaddedRows(chunks, columns, contIndent);

  return (
    <>
      {rows.map((row, ri) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static, never reorder
        <Text key={ri} backgroundColor={bgLine} dimColor={kind === "remove"}>
          {row.map((c, ci) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: chunks are static
            <Text key={ci} color={c.color} dimColor={c.dimColor}>
              {c.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

export function AdvancedDiffRenderer(
  props: Props & { precomputed?: AdvancedDiffSuccess },
) {
  // Must call hooks at top level before any early returns
  const columns = useTerminalWidth();

  const result = useMemo(() => {
    if (props.precomputed) return props.precomputed;
    if (props.kind === "write") {
      return computeAdvancedDiff(
        { kind: "write", filePath: props.filePath, content: props.content },
        { oldStrOverride: props.oldContentOverride },
      );
    } else if (props.kind === "edit") {
      return computeAdvancedDiff(
        {
          kind: "edit",
          filePath: props.filePath,
          oldString: props.oldString,
          newString: props.newString,
          replaceAll: props.replaceAll,
        },
        { oldStrOverride: props.oldContentOverride },
      );
    } else {
      return computeAdvancedDiff(
        { kind: "multi_edit", filePath: props.filePath, edits: props.edits },
        { oldStrOverride: props.oldContentOverride },
      );
    }
  }, [props]);

  const showHeader = props.showHeader !== false; // default to true

  if (result.mode === "fallback") {
    // Render simple arg-based fallback for readability
    const filePathForFallback = (props as { filePath: string }).filePath;
    if (props.kind === "write") {
      return (
        <WriteRenderer filePath={filePathForFallback} content={props.content} />
      );
    }
    if (props.kind === "edit") {
      return (
        <EditRenderer
          filePath={filePathForFallback}
          oldString={props.oldString}
          newString={props.newString}
        />
      );
    }
    // multi_edit fallback
    if (props.kind === "multi_edit") {
      const edits = (props.edits || []).map((e) => ({
        old_string: e.old_string,
        new_string: e.new_string,
      }));
      return <MultiEditRenderer filePath={filePathForFallback} edits={edits} />;
    }
    return <MultiEditRenderer filePath={filePathForFallback} edits={[]} />;
  }

  if (result.mode === "unpreviewable") {
    const gutterWidth = 4;
    return (
      <Box flexDirection="row">
        <Box width={gutterWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>⎿</Text>
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="wrap" dimColor>
            Cannot preview changes: {result.reason}
          </Text>
        </Box>
      </Box>
    );
  }

  const { hunks } = result;
  const filePath = (props as { filePath: string }).filePath;
  const relative = formatRelativePath(filePath);

  // Syntax-highlight all hunk content at once per hunk (preserves parser state
  // across consecutive lines, like Codex's hunk-level highlighting approach).
  const lang = languageFromPath(filePath);
  const hunkSyntaxLines: (StyledSpan[] | undefined)[][] = [];
  for (const h of hunks) {
    // Concatenate all displayable lines in the hunk for a single highlight pass.
    const textLines: string[] = [];
    for (const line of h.lines) {
      if (!line) continue;
      const raw = line.raw || "";
      if (raw.charAt(0) === "\\") continue; // skip meta
      textLines.push(raw.slice(1));
    }
    const block = textLines.join("\n");
    const highlighted = lang ? highlightCode(block, lang) : undefined;
    // Map highlighted per-line spans back; undefined when highlighting failed.
    hunkSyntaxLines.push(textLines.map((_, i) => highlighted?.[i]));
  }

  // Prepare display rows with shared-line-number behavior.
  type Row = {
    kind: "context" | "remove" | "add";
    displayNo: number;
    text: string;
    syntaxSpans?: StyledSpan[];
  };
  const rows: Row[] = [];
  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const h = hunks[hIdx];
    if (!h) {
      continue;
    }

    const syntaxForHunk = hunkSyntaxLines[hIdx] ?? [];
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    let lastRemovalNo: number | null = null;
    let displayLineIdx = 0; // index into syntaxForHunk
    for (let i = 0; i < h.lines.length; i++) {
      const line = h.lines[i];
      if (!line) continue;
      const raw = line.raw || "";
      const ch = raw.charAt(0);
      const body = raw.slice(1);
      // Skip meta lines (e.g., "\ No newline at end of file")
      if (ch === "\\") continue;

      const spans = syntaxForHunk[displayLineIdx];
      displayLineIdx++;

      if (ch === " ") {
        rows.push({
          kind: "context",
          displayNo: oldNo,
          text: body,
          syntaxSpans: spans,
        });
        oldNo++;
        newNo++;
        lastRemovalNo = null;
      } else if (ch === "-") {
        rows.push({
          kind: "remove",
          displayNo: oldNo,
          text: body,
          syntaxSpans: spans,
        });
        lastRemovalNo = oldNo;
        oldNo++;
      } else if (ch === "+") {
        const displayNo = lastRemovalNo !== null ? lastRemovalNo : newNo;
        rows.push({ kind: "add", displayNo, text: body, syntaxSpans: spans });
        newNo++;
        lastRemovalNo = null;
      } else {
        rows.push({
          kind: "context",
          displayNo: oldNo,
          text: raw,
          syntaxSpans: spans,
        });
        oldNo++;
        newNo++;
        lastRemovalNo = null;
      }
    }
  }
  // Compute gutter width based on the maximum display number we will render,
  // so multi-digit line numbers (e.g., 10) never wrap.
  const maxDisplayNo = rows.reduce((m, r) => Math.max(m, r.displayNo), 1);
  const gutterWidth = String(maxDisplayNo).length;

  const header =
    props.kind === "write"
      ? `Wrote changes to ${relative}`
      : `Updated ${relative}`;

  // If no changes (empty diff), show a message with filepath
  if (rows.length === 0) {
    const noChangesGutter = 4;
    return (
      <Box flexDirection="column">
        {showHeader ? (
          <Box flexDirection="row">
            <Box width={noChangesGutter} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>⎿</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - noChangesGutter)}>
              <Text wrap="wrap">{header}</Text>
            </Box>
          </Box>
        ) : null}
        <Box flexDirection="row">
          <Box width={noChangesGutter} flexShrink={0}>
            <Text>{"    "}</Text>
          </Box>
          <Box flexGrow={1} width={Math.max(0, columns - noChangesGutter)}>
            <Text dimColor>
              No changes to <Text bold>{relative}</Text> (file content
              identical)
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Gutter width for "  ⎿" prefix (4 chars: 2 spaces + ⎿ + space)
  const toolResultGutter = 4;

  return (
    <Box flexDirection="column">
      {showHeader ? (
        <>
          <Box flexDirection="row">
            <Box width={toolResultGutter} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>⎿</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - toolResultGutter)}>
              <Text wrap="wrap">{header}</Text>
            </Box>
          </Box>
          <Box flexDirection="row">
            <Box width={toolResultGutter} flexShrink={0}>
              <Text>{"    "}</Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - toolResultGutter)}>
              <Text
                dimColor
              >{`Showing ~${ADV_DIFF_CONTEXT_LINES} context line${ADV_DIFF_CONTEXT_LINES === 1 ? "" : "s"}`}</Text>
            </Box>
          </Box>
        </>
      ) : null}
      {rows.map((r, idx) => (
        <Line
          key={`row-${idx}-${r.kind}-${r.displayNo || idx}`}
          kind={r.kind}
          displayNo={r.displayNo}
          text={r.text}
          syntaxSpans={r.syntaxSpans}
          gutterWidth={gutterWidth}
          columns={columns}
          indent={showHeader ? " ".repeat(toolResultGutter) : ""}
        />
      ))}
    </Box>
  );
}
