import { relative } from "node:path";
import * as Diff from "diff";
import { Box, Text } from "ink";
import { useMemo } from "react";
import {
  ADV_DIFF_CONTEXT_LINES,
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
} from "../helpers/diff";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { EditRenderer, MultiEditRenderer, WriteRenderer } from "./DiffRenderer";

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

// Render a single line with gutters and optional word-diff highlighting
function Line({
  kind,
  displayNo,
  text,
  pairText,
  gutterWidth,
  contentWidth,
  enableWord,
}: {
  kind: "context" | "remove" | "add";
  displayNo: number;
  text: string;
  pairText?: string; // when '-' followed by '+' to highlight words
  gutterWidth: number;
  contentWidth: number;
  enableWord: boolean;
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
  const bgWord =
    kind === "add"
      ? colors.diff.addedWordBg
      : kind === "remove"
        ? colors.diff.removedWordBg
        : undefined;

  // Char-level diff only for '-' or '+' when pairText is present
  const charParts: Array<{
    value: string;
    added?: boolean;
    removed?: boolean;
  }> | null =
    enableWord &&
    pairText &&
    (kind === "add" || kind === "remove") &&
    pairText !== text
      ? kind === "add"
        ? Diff.diffChars(pairText, text)
        : Diff.diffChars(text, pairText)
      : null;

  // Compute remaining width for the text area within this row
  const textWidth = Math.max(0, contentWidth - gutterWidth - 2);

  return (
    <Box width={contentWidth}>
      <Box width={gutterWidth}>
        <Text dimColor>{padLeft(displayNo, gutterWidth)}</Text>
      </Box>
      <Box width={2}>
        <Text color={symbolColor}>{symbol}</Text>
        <Text> </Text>
      </Box>
      <Box width={textWidth}>
        {charParts ? (
          <Text>
            {charParts.map((p, i) => {
              // For '-' lines: render removed + unchanged; drop added
              if (kind === "remove") {
                if (p.removed)
                  return (
                    <Text
                      key={`${kind}-${i}-${p.value.substring(0, 10)}`}
                      backgroundColor={bgWord}
                      color={colors.diff.textOnHighlight}
                    >
                      {p.value}
                    </Text>
                  );
                if (!p.added && !p.removed)
                  return (
                    <Text
                      key={`${kind}-${i}-${p.value.substring(0, 10)}`}
                      backgroundColor={bgLine}
                      color={colors.diff.textOnDark}
                    >
                      {p.value}
                    </Text>
                  );
                return null; // skip added segments on '-'
              }
              // For '+' lines: render added + unchanged; drop removed
              if (kind === "add") {
                if (p.added)
                  return (
                    <Text
                      key={`${kind}-${i}-${p.value.substring(0, 10)}`}
                      backgroundColor={bgWord}
                      color={colors.diff.textOnHighlight}
                    >
                      {p.value}
                    </Text>
                  );
                if (!p.added && !p.removed)
                  return (
                    <Text
                      key={`${kind}-${i}-${p.value.substring(0, 10)}`}
                      backgroundColor={bgLine}
                      color={colors.diff.textOnDark}
                    >
                      {p.value}
                    </Text>
                  );
                return null; // skip removed segments on '+'
              }
              // Context (should not occur with charParts), fall back to full line
              return (
                <Text
                  key={`context-${i}-${p.value.substring(0, 10)}`}
                  backgroundColor={bgLine}
                >
                  {p.value}
                </Text>
              );
            })}
          </Text>
        ) : (
          <Text
            backgroundColor={bgLine}
            color={kind === "context" ? undefined : colors.diff.textOnDark}
          >
            {text}
          </Text>
        )}
      </Box>
    </Box>
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
    return (
      <Box flexDirection="column">
        <Text dimColor> ⎿ Cannot preview changes: {result.reason}</Text>
      </Box>
    );
  }

  const { hunks } = result;
  const relative = formatRelativePath((props as { filePath: string }).filePath);
  const enableWord = props.kind !== "multi_edit";

  // Prepare display rows with shared-line-number behavior like the snippet.
  type Row = {
    kind: "context" | "remove" | "add";
    displayNo: number;
    text: string;
    pairText?: string;
  };
  const rows: Row[] = [];
  for (const h of hunks) {
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    let lastRemovalNo: number | null = null;
    for (let i = 0; i < h.lines.length; i++) {
      const line = h.lines[i];
      if (!line) continue;
      const raw = line.raw || "";
      const ch = raw.charAt(0);
      const body = raw.slice(1);
      // Skip meta lines (e.g., "\ No newline at end of file"): do not display, do not advance counters,
      // and do not clear pairing state.
      if (ch === "\\") continue;

      // Helper to find next non-meta '+' index
      const findNextPlus = (start: number): string | undefined => {
        for (let j = start + 1; j < h.lines.length; j++) {
          const nextLine = h.lines[j];
          if (!nextLine) continue;
          const r = nextLine.raw || "";
          if (r.charAt(0) === "\\") continue; // skip meta
          if (r.startsWith("+")) return r.slice(1);
          break; // stop at first non-meta non-plus
        }
        return undefined;
      };
      // Helper to find previous non-meta '-' index
      const findPrevMinus = (start: number): string | undefined => {
        for (let k = start - 1; k >= 0; k--) {
          const prevLine = h.lines[k];
          if (!prevLine) continue;
          const r = prevLine.raw || "";
          if (r.charAt(0) === "\\") continue; // skip meta
          if (r.startsWith("-")) return r.slice(1);
          break; // stop at first non-meta non-minus
        }
        return undefined;
      };
      if (ch === " ") {
        rows.push({ kind: "context", displayNo: oldNo, text: body });
        oldNo++;
        newNo++;
        lastRemovalNo = null;
      } else if (ch === "-") {
        rows.push({
          kind: "remove",
          displayNo: oldNo,
          text: body,
          pairText: findNextPlus(i),
        });
        lastRemovalNo = oldNo;
        oldNo++;
      } else if (ch === "+") {
        // For insertions (no preceding '-'), use newNo for display number.
        // For single-line replacements, share the old number from the '-' line.
        const displayNo = lastRemovalNo !== null ? lastRemovalNo : newNo;
        rows.push({
          kind: "add",
          displayNo,
          text: body,
          pairText: findPrevMinus(i),
        });
        newNo++;
        lastRemovalNo = null;
      } else {
        // Unknown marker, treat as context
        rows.push({ kind: "context", displayNo: oldNo, text: raw });
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

  // Best-effort width clamp for rendering inside approval panel (border + padding + indent ~ 8 cols)
  const panelInnerWidth = Math.max(20, columns - 8); // keep a reasonable minimum

  return (
    <Box flexDirection="column" width={panelInnerWidth}>
      {showHeader ? (
        <>
          <Text>{header}</Text>
          <Text
            dimColor
          >{`Showing ~${ADV_DIFF_CONTEXT_LINES} context line${ADV_DIFF_CONTEXT_LINES === 1 ? "" : "s"}`}</Text>
        </>
      ) : null}
      {rows.map((r, idx) => (
        <Line
          key={`row-${idx}-${r.kind}-${r.displayNo || idx}`}
          kind={r.kind}
          displayNo={r.displayNo}
          text={r.text}
          pairText={r.pairText}
          gutterWidth={gutterWidth}
          contentWidth={panelInnerWidth}
          enableWord={enableWord}
        />
      ))}
    </Box>
  );
}
