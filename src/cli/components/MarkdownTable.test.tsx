import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import {
  layoutMarkdownTable,
  parseMarkdownTable,
  splitMarkdownTableRow,
  tableCellDisplayText,
} from "./MarkdownTable.js";

class CaptureStream extends Writable {
  columns: number;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  constructor(columns: number) {
    super();
    this.columns = columns;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

async function renderMarkdown(
  markdown: string,
  contentWidth: number,
): Promise<string> {
  const stdout = new CaptureStream(contentWidth) as CaptureStream &
    NodeJS.WriteStream;
  const instance = render(
    <MarkdownDisplay text={markdown} contentWidth={contentWidth} />,
    {
      stdout,
      stdin: createInputStream(),
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();
  return stripAnsi(stdout.chunks.join(""));
}

function requireParsedTable(lines: string[]) {
  const table = parseMarkdownTable(lines);
  if (!table) throw new Error("Expected a valid Markdown table");
  return table;
}

const issueTable = [
  "| Area | #3292 | #3294/current main |",
  "|---|---|---|",
  "| ChatGPT Sol/Terra presets | Adds them | Already merged separately in main |",
  "| ChatGPT Luna preset | Adds full static preset | #3294 consumes and extends them |",
  "| Reasoning tiers | Stops at xhigh, labeling it Max | Distinguishes xhigh from true max, matching pi-ai 0.80.6 |",
  "| Local runtime support | None | Upgrades pi-ai, catalogs models, and updates streaming/compaction |",
  "| Picker behavior | Adds normalization tests | Fixes metadata mapping, Recents, labels, and reasoning selection |",
  "| Model ordering | Reorders featured models and demotes GPT-5.5 | Not part of #3294 |",
];

test("table parser preserves escaped and code-span pipes", () => {
  expect(splitMarkdownTableRow("| escaped\\|pipe | `a|b` | value |")).toEqual([
    "escaped|pipe",
    "`a|b`",
    "value",
  ]);
});

test("table parser reads GFM column alignment", () => {
  const table = parseMarkdownTable([
    "| Left | Center | Right |",
    "|:---|:---:|---:|",
    "| one | two | three |",
  ]);

  expect(table?.alignments).toEqual(["left", "center", "right"]);
  expect(table?.rows).toEqual([["one", "two", "three"]]);
});

test("table measurements use displayed inline markdown text", () => {
  expect(tableCellDisplayText("**Bold** and `code`")).toBe("Bold and code");
  expect(tableCellDisplayText("[label](https://example.com)")).toBe(
    "label (https://example.com)",
  );
});

test("compact tables remain grids when they fit", () => {
  const table = requireParsedTable([
    "| Status | Count |",
    "|---|---:|",
    "| Ready | 4 |",
    "| Done | 12 |",
  ]);
  const layout = layoutMarkdownTable(table, 80);

  expect(layout.mode).toBe("grid");
  if (layout.mode === "grid") {
    const renderedWidth =
      layout.columnWidths.reduce((total, width) => total + width + 2, 0) + 2;
    expect(renderedWidth).toBeLessThanOrEqual(80);
  }
});

test("wide Unicode cells stay within the grid width budget", () => {
  const table = requireParsedTable([
    "| Name | Status |",
    "|---|---|",
    "| 東京 | ✅ Ready |",
    "| München | Complete |",
  ]);
  const layout = layoutMarkdownTable(table, 32);

  expect(layout.mode).toBe("grid");
  if (layout.mode === "grid") {
    const renderedWidth =
      layout.columnWidths.reduce((total, width) => total + width + 2, 0) + 2;
    expect(renderedWidth).toBeLessThanOrEqual(32);
  }
});

test("the issue table keeps readable columns at a normal width", () => {
  const table = requireParsedTable(issueTable);
  const layout = layoutMarkdownTable(table, 120);

  expect(layout.mode).toBe("grid");
  if (layout.mode === "grid") {
    const renderedWidth =
      layout.columnWidths.reduce((total, width) => total + width + 2, 0) +
      (layout.columnWidths.length - 1) * 2;
    expect(renderedWidth).toBeLessThanOrEqual(120);
    expect(layout.columnWidths[0]).toBeLessThan(layout.columnWidths[2] ?? 0);
  }
});

test("prose-heavy tables fall back to records when columns become cramped", () => {
  const issue = requireParsedTable(issueTable);
  const pathHeavy = requireParsedTable([
    "| Path | Description |",
    "|---|---|",
    "| /workspace/very-long-directory/generated/artifact.json | Copies generated artifacts into the destination directory after validation completes |",
  ]);

  expect(layoutMarkdownTable(pathHeavy, 50).mode).toBe("aligned-records");
  expect(layoutMarkdownTable(issue, 42).mode).toBe("stacked-records");
});

test("rendered tables use borderless row separators instead of boxes", async () => {
  const output = await renderMarkdown(
    [
      "| Name | Status |",
      "|---|---|",
      "| Alpha | Ready |",
      "| Beta | Done |",
    ].join("\n"),
    80,
  );

  expect(output).toContain("Name");
  expect(output).toContain("━");
  expect(output).toContain("─");
  expect(output).not.toContain("│");
  expect(output).not.toContain("┼");
});
