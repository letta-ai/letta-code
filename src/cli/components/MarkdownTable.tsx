import { Box } from "ink";
import type React from "react";
import stringWidth from "string-width";
import { colors } from "./colors.js";
import { InlineMarkdown } from "./InlineMarkdownRenderer.js";
import { Text } from "./Text";

const COLUMN_GAP = 2;
const CELL_PADDING = 1;
const MIN_COLUMN_WIDTH = 3;
const EXPANSIVE_COLUMN_FLOOR = 16;
const MIN_SCANNABLE_EXPANSIVE_WIDTH = 12;
const CRAMPED_EXPANSIVE_CELL_LINES = 4;
const CATASTROPHIC_NARRATIVE_CELL_LINES = 7;
const FIELD_LEADING_PADDING = 1;
const FIELD_GAP = 2;
const MIN_ALIGNED_COMPACT_VALUE_WIDTH = 12;
const MIN_ALIGNED_EXPANSIVE_VALUE_WIDTH = 24;

export type TableAlignment = "left" | "center" | "right";
type TableColumnKind = "compact" | "narrative" | "token-heavy";

export interface ParsedMarkdownTable {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

interface TableColumnMetrics {
  maxWidth: number;
  headerTokenWidth: number;
  bodyTokenWidth: number;
  kind: TableColumnKind;
}

export type MarkdownTableLayout =
  | { mode: "grid"; columnWidths: number[] }
  | { mode: "aligned-records"; labelWidth: number }
  | { mode: "stacked-records"; labelWidth: number };

interface MarkdownTableProps {
  tableLines: string[];
  contentWidth?: number;
  dimColor?: boolean;
  backgroundColor?: string;
}

function countBackticks(value: string, start: number): number {
  let count = 0;
  while (value[start + count] === "`") count++;
  return count;
}

export function splitMarkdownTableRow(row: string): string[] {
  let source = row.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let codeFenceLength = 0;

  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? "";
    if (character === "\\" && source[index + 1] === "|") {
      current += "|";
      index++;
      continue;
    }
    if (character === "`") {
      const runLength = countBackticks(source, index);
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (runLength === codeFenceLength) codeFenceLength = 0;
      current += "`".repeat(runLength);
      index += runLength - 1;
      continue;
    }
    if (character === "|" && codeFenceLength === 0) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  cells.push(current.trim());
  return cells;
}

function alignmentFromDelimiter(delimiter: string): TableAlignment {
  const value = delimiter.trim();
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function normalizeRow(row: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
}

export function parseMarkdownTable(
  tableLines: string[],
): ParsedMarkdownTable | null {
  const headerLine = tableLines[0];
  const delimiterLine = tableLines[1];
  if (!headerLine || !delimiterLine) return null;

  const headers = splitMarkdownTableRow(headerLine);
  if (headers.length === 0) return null;
  const delimiters = splitMarkdownTableRow(delimiterLine);
  if (delimiters.length !== headers.length) return null;

  return {
    headers,
    alignments: delimiters.map(alignmentFromDelimiter),
    rows: tableLines
      .slice(2)
      .map(splitMarkdownTableRow)
      .map((row) => normalizeRow(row, headers.length)),
  };
}

export function tableCellDisplayText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\\([\\|`*~[\]])/g, "$1");
}

function displayWidth(value: string): number {
  return stringWidth(tableCellDisplayText(value));
}

function longestTokenWidth(value: string): number {
  return tableCellDisplayText(value)
    .split(/\s+/)
    .reduce((maximum, token) => Math.max(maximum, stringWidth(token)), 0);
}

function collectColumnMetrics(
  table: ParsedMarkdownTable,
): TableColumnMetrics[] {
  return table.headers.map((header, column) => {
    const bodyValues = table.rows.map((row) => row[column] ?? "");
    const nonEmptyValues = bodyValues.filter(
      (value) => value.trim().length > 0,
    );
    const bodyTokens = nonEmptyValues.flatMap((value) =>
      tableCellDisplayText(value).split(/\s+/).filter(Boolean),
    );
    const longTokenCount = bodyTokens.filter(
      (token) => stringWidth(token) >= 20,
    ).length;
    const totalWords = nonEmptyValues.reduce(
      (total, value) =>
        total + tableCellDisplayText(value).split(/\s+/).filter(Boolean).length,
      0,
    );
    const totalWidth = nonEmptyValues.reduce(
      (total, value) => total + displayWidth(value),
      0,
    );
    const averageWords =
      nonEmptyValues.length > 0
        ? totalWords / nonEmptyValues.length
        : tableCellDisplayText(header).split(/\s+/).filter(Boolean).length;
    const averageWidth =
      nonEmptyValues.length > 0
        ? totalWidth / nonEmptyValues.length
        : displayWidth(header);
    const kind: TableColumnKind =
      longTokenCount > 0 && longTokenCount >= bodyTokens.length - longTokenCount
        ? "token-heavy"
        : averageWords >= 4 || averageWidth >= 28
          ? "narrative"
          : "compact";

    return {
      maxWidth: bodyValues.reduce(
        (maximum, value) => Math.max(maximum, displayWidth(value)),
        Math.max(displayWidth(header), MIN_COLUMN_WIDTH),
      ),
      headerTokenWidth: longestTokenWidth(header),
      bodyTokenWidth: bodyValues.reduce(
        (maximum, value) => Math.max(maximum, longestTokenWidth(value)),
        0,
      ),
      kind,
    };
  });
}

function preferredColumnFloor(metrics: TableColumnMetrics): number {
  const target =
    metrics.kind === "compact"
      ? Math.max(metrics.headerTokenWidth, Math.min(metrics.bodyTokenWidth, 16))
      : EXPANSIVE_COLUMN_FLOOR;
  return Math.max(MIN_COLUMN_WIDTH, Math.min(target, metrics.maxWidth));
}

function shrinkPriority(kind: TableColumnKind): number {
  if (kind === "token-heavy") return 0;
  if (kind === "narrative") return 1;
  return 2;
}

function allocateColumnWidths(
  metrics: TableColumnMetrics[],
  availableWidth: number | undefined,
): number[] | null {
  const widths = metrics.map((column) => column.maxWidth);
  if (availableWidth === undefined) return widths;
  if (availableWidth < metrics.length * MIN_COLUMN_WIDTH) return null;

  const floors = metrics.map(preferredColumnFloor);
  let floorTotal = floors.reduce((total, width) => total + width, 0);
  while (floorTotal > availableWidth) {
    let candidate = -1;
    for (let index = 0; index < floors.length; index++) {
      if ((floors[index] ?? 0) <= MIN_COLUMN_WIDTH) continue;
      if (
        candidate === -1 ||
        shrinkPriority(metrics[index]?.kind ?? "compact") <
          shrinkPriority(metrics[candidate]?.kind ?? "compact") ||
        (shrinkPriority(metrics[index]?.kind ?? "compact") ===
          shrinkPriority(metrics[candidate]?.kind ?? "compact") &&
          (floors[index] ?? 0) > (floors[candidate] ?? 0))
      ) {
        candidate = index;
      }
    }
    if (candidate === -1) break;
    floors[candidate] = (floors[candidate] ?? MIN_COLUMN_WIDTH) - 1;
    floorTotal--;
  }

  let totalWidth = widths.reduce((total, width) => total + width, 0);
  while (totalWidth > availableWidth) {
    let candidate = -1;
    for (let index = 0; index < widths.length; index++) {
      const slack = (widths[index] ?? 0) - (floors[index] ?? 0);
      if (slack <= 0) continue;
      if (
        candidate === -1 ||
        shrinkPriority(metrics[index]?.kind ?? "compact") <
          shrinkPriority(metrics[candidate]?.kind ?? "compact") ||
        (shrinkPriority(metrics[index]?.kind ?? "compact") ===
          shrinkPriority(metrics[candidate]?.kind ?? "compact") &&
          slack > (widths[candidate] ?? 0) - (floors[candidate] ?? 0))
      ) {
        candidate = index;
      }
    }
    if (candidate === -1) return null;
    widths[candidate] = (widths[candidate] ?? MIN_COLUMN_WIDTH) - 1;
    totalWidth--;
  }

  return widths;
}

function hardWrappedTokenLines(token: string, width: number): number {
  return Math.max(1, Math.ceil(stringWidth(token) / Math.max(1, width)));
}

function wrappedLineCount(value: string, width: number): number {
  const words = tableCellDisplayText(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;

  let lines = 1;
  let currentWidth = 0;
  for (const word of words) {
    const wordWidth = stringWidth(word);
    if (wordWidth > width) {
      if (currentWidth > 0) lines++;
      lines += hardWrappedTokenLines(word, width) - 1;
      currentWidth = wordWidth % width;
      continue;
    }
    const nextWidth =
      currentWidth === 0 ? wordWidth : currentWidth + 1 + wordWidth;
    if (nextWidth > width) {
      lines++;
      currentWidth = wordWidth;
    } else {
      currentWidth = nextWidth;
    }
  }
  return lines;
}

function rowNeedsRecordLayout(
  row: string[],
  widths: number[],
  metrics: TableColumnMetrics[],
): boolean {
  const fragmented = row.some((cell, column) => {
    const width = widths[column] ?? MIN_COLUMN_WIDTH;
    const hasWideToken = tableCellDisplayText(cell)
      .split(/\s+/)
      .some((token) => stringWidth(token) > width);
    const kind = metrics[column]?.kind ?? "compact";
    if (kind === "compact") return hasWideToken;
    if (kind === "token-heavy") {
      return width < MIN_SCANNABLE_EXPANSIVE_WIDTH && hasWideToken;
    }
    return false;
  });
  if (fragmented) return true;

  const expansiveCells = row
    .map((cell, column) => ({
      kind: metrics[column]?.kind ?? "compact",
      width: widths[column] ?? MIN_COLUMN_WIDTH,
      lines: wrappedLineCount(cell, widths[column] ?? MIN_COLUMN_WIDTH),
    }))
    .filter((cell) => cell.kind !== "compact");

  return (
    expansiveCells.filter((cell) => cell.lines >= CRAMPED_EXPANSIVE_CELL_LINES)
      .length >= 2 ||
    expansiveCells.some(
      (cell) =>
        cell.kind === "narrative" &&
        cell.width < MIN_SCANNABLE_EXPANSIVE_WIDTH &&
        cell.lines >= CATASTROPHIC_NARRATIVE_CELL_LINES,
    )
  );
}

function shouldRenderRecords(
  table: ParsedMarkdownTable,
  widths: number[],
  metrics: TableColumnMetrics[],
): boolean {
  if (table.rows.length === 0) return false;
  const affectedRows = table.rows.filter((row) =>
    rowNeedsRecordLayout(row, widths, metrics),
  ).length;
  const threshold =
    table.rows.length === 1 ? 1 : Math.max(2, Math.ceil(table.rows.length / 3));
  return affectedRows >= threshold;
}

function recordLayout(
  table: ParsedMarkdownTable,
  metrics: TableColumnMetrics[],
  contentWidth: number | undefined,
): MarkdownTableLayout {
  const labelWidth = table.headers.reduce(
    (maximum, header) => Math.max(maximum, displayWidth(header)),
    0,
  );
  const minimumValueWidth = metrics.some((column) => column.kind !== "compact")
    ? MIN_ALIGNED_EXPANSIVE_VALUE_WIDTH
    : MIN_ALIGNED_COMPACT_VALUE_WIDTH;
  const aligned =
    contentWidth === undefined ||
    FIELD_LEADING_PADDING + labelWidth + FIELD_GAP + minimumValueWidth <=
      contentWidth;
  return {
    mode: aligned ? "aligned-records" : "stacked-records",
    labelWidth,
  };
}

export function layoutMarkdownTable(
  table: ParsedMarkdownTable,
  contentWidth?: number,
): MarkdownTableLayout {
  const metrics = collectColumnMetrics(table);
  const overhead =
    table.headers.length * CELL_PADDING * 2 +
    Math.max(0, table.headers.length - 1) * COLUMN_GAP;
  const availableWidth =
    contentWidth === undefined
      ? undefined
      : Math.max(0, contentWidth - overhead);
  const columnWidths = allocateColumnWidths(metrics, availableWidth);

  if (
    columnWidths === null ||
    shouldRenderRecords(table, columnWidths, metrics)
  ) {
    return recordLayout(table, metrics, contentWidth);
  }
  return { mode: "grid", columnWidths };
}

function alignmentPadding(
  value: string,
  width: number,
  alignment: TableAlignment,
): { left: string; right: string } {
  const remaining = Math.max(0, width - displayWidth(value));
  if (alignment === "right") {
    return { left: " ".repeat(remaining), right: "" };
  }
  if (alignment === "center") {
    const left = Math.floor(remaining / 2);
    return { left: " ".repeat(left), right: " ".repeat(remaining - left) };
  }
  return { left: "", right: " ".repeat(remaining) };
}

function TableCell({
  value,
  width,
  alignment,
  bold,
  color,
  dimColor,
  backgroundColor,
}: {
  value: string;
  width: number;
  alignment: TableAlignment;
  bold?: boolean;
  color?: string;
  dimColor?: boolean;
  backgroundColor?: string;
}) {
  const padding =
    displayWidth(value) <= width
      ? alignmentPadding(value, width, alignment)
      : { left: "", right: "" };
  return (
    <Box
      width={width + CELL_PADDING * 2}
      paddingX={CELL_PADDING}
      flexShrink={0}
    >
      <Text
        wrap="wrap"
        bold={bold}
        color={color}
        dimColor={dimColor}
        backgroundColor={backgroundColor}
      >
        {padding.left}
        <InlineMarkdown
          text={value || " "}
          dimColor={dimColor}
          backgroundColor={backgroundColor}
        />
        {padding.right}
      </Text>
    </Box>
  );
}

function ColumnGap() {
  return <Box width={COLUMN_GAP} flexShrink={0} />;
}

function GridTable({
  table,
  columnWidths,
  dimColor,
  backgroundColor,
}: {
  table: ParsedMarkdownTable;
  columnWidths: number[];
  dimColor?: boolean;
  backgroundColor?: string;
}) {
  const separator = (character: string) =>
    columnWidths
      .map((width) => character.repeat(width + CELL_PADDING * 2))
      .join(" ".repeat(COLUMN_GAP));
  const renderRow = (row: string[], rowIndex: number, isHeader: boolean) => (
    <Box key={`${isHeader ? "header" : "row"}-${rowIndex}`} flexDirection="row">
      {row.map((value, column) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: table columns are static within one render
        <Box key={`column-${column}`} flexDirection="row" flexShrink={0}>
          {column > 0 ? <ColumnGap /> : null}
          <TableCell
            value={value}
            width={columnWidths[column] ?? MIN_COLUMN_WIDTH}
            alignment={table.alignments[column] ?? "left"}
            bold={isHeader}
            color={isHeader ? colors.heading.secondary : undefined}
            dimColor={dimColor}
            backgroundColor={backgroundColor}
          />
        </Box>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {renderRow(table.headers, 0, true)}
      <Text dimColor backgroundColor={backgroundColor}>
        {separator("━")}
      </Text>
      {table.rows.map((row, rowIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: table rows are static within one render
        <Box key={`record-${rowIndex}`} flexDirection="column">
          {renderRow(row, rowIndex, false)}
          {rowIndex + 1 < table.rows.length ? (
            <Text dimColor backgroundColor={backgroundColor}>
              {separator("─")}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

function RecordSeparator({
  width,
  backgroundColor,
}: {
  width?: number;
  backgroundColor?: string;
}) {
  return (
    <Text dimColor backgroundColor={backgroundColor}>
      {"─".repeat(Math.max(1, width ?? 40))}
    </Text>
  );
}

function RecordTable({
  table,
  layout,
  contentWidth,
  dimColor,
  backgroundColor,
}: {
  table: ParsedMarkdownTable;
  layout: Extract<
    MarkdownTableLayout,
    { mode: "aligned-records" | "stacked-records" }
  >;
  contentWidth?: number;
  dimColor?: boolean;
  backgroundColor?: string;
}) {
  return (
    <Box flexDirection="column">
      {table.rows.map((row, rowIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: table rows are static within one render
        <Box key={`record-${rowIndex}`} flexDirection="column">
          {row.map((value, column) => {
            const header = table.headers[column] ?? `Column ${column + 1}`;
            if (layout.mode === "aligned-records") {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: table fields are static within one render
                <Box key={`field-${column}`} flexDirection="row">
                  <Box width={FIELD_LEADING_PADDING} flexShrink={0} />
                  <Box width={layout.labelWidth + FIELD_GAP} flexShrink={0}>
                    <Text
                      bold
                      color={colors.heading.secondary}
                      backgroundColor={backgroundColor}
                    >
                      <InlineMarkdown
                        text={header}
                        backgroundColor={backgroundColor}
                      />
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text
                      wrap="wrap"
                      dimColor={dimColor}
                      backgroundColor={backgroundColor}
                    >
                      <InlineMarkdown
                        text={value || " "}
                        dimColor={dimColor}
                        backgroundColor={backgroundColor}
                      />
                    </Text>
                  </Box>
                </Box>
              );
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: table fields are static within one render
              <Box key={`field-${column}`} flexDirection="column">
                <Box paddingLeft={FIELD_LEADING_PADDING}>
                  <Text
                    bold
                    color={colors.heading.secondary}
                    backgroundColor={backgroundColor}
                  >
                    <InlineMarkdown
                      text={header}
                      backgroundColor={backgroundColor}
                    />
                  </Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text
                    wrap="wrap"
                    dimColor={dimColor}
                    backgroundColor={backgroundColor}
                  >
                    <InlineMarkdown
                      text={value || " "}
                      dimColor={dimColor}
                      backgroundColor={backgroundColor}
                    />
                  </Text>
                </Box>
              </Box>
            );
          })}
          {rowIndex + 1 < table.rows.length ? (
            <RecordSeparator
              width={contentWidth}
              backgroundColor={backgroundColor}
            />
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export function MarkdownTable({
  tableLines,
  contentWidth,
  dimColor,
  backgroundColor,
}: MarkdownTableProps): React.ReactNode {
  const table = parseMarkdownTable(tableLines);
  if (!table) return null;
  const layout = layoutMarkdownTable(table, contentWidth);
  if (layout.mode === "grid") {
    return (
      <GridTable
        table={table}
        columnWidths={layout.columnWidths}
        dimColor={dimColor}
        backgroundColor={backgroundColor}
      />
    );
  }
  return (
    <RecordTable
      table={table}
      layout={layout}
      contentWidth={contentWidth}
      dimColor={dimColor}
      backgroundColor={backgroundColor}
    />
  );
}
