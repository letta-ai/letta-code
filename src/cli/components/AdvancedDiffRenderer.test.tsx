import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import {
  AdvancedDiffRenderer,
  buildAdvancedDiffRows,
} from "./AdvancedDiffRenderer";

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

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

async function renderAdvancedDiff(
  precomputed: AdvancedDiffSuccess,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <AdvancedDiffRenderer
      kind="edit"
      filePath="/tmp/example.ts"
      oldString="old"
      newString="new"
      showHeader={false}
      precomputed={precomputed}
    />,
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

test("advanced diff rows number added lines from the new file", () => {
  const rows = buildAdvancedDiffRows([
    {
      oldStart: 1,
      newStart: 1,
      lines: [
        { raw: " export function f() {" },
        { raw: "-\tconst customTool = tools.find(isCustomTool);" },
        { raw: "-" },
        { raw: "-\tif (customTool) {" },
        { raw: "+\tconst functionTools = [];" },
        { raw: "+\tfor (const tool of tools) {" },
        { raw: "+\t\tif (isCustomTool(tool)) {" },
        { raw: ' \t\t\tthrow new Error("x");' },
        { raw: " \t\t}" },
        { raw: "-\treturn tools;" },
        { raw: "+\t\tfunctionTools.push(tool);" },
        { raw: " \t}" },
        { raw: "+\treturn functionTools;" },
        { raw: "+}" },
      ],
    },
  ]);

  const signForKind = { context: " ", remove: "-", add: "+" } as const;

  expect(rows.map((row) => `${row.displayNo}${signForKind[row.kind]}`)).toEqual(
    [
      "1 ",
      "2-",
      "3-",
      "4-",
      "2+",
      "3+",
      "4+",
      "5 ",
      "6 ",
      "7-",
      "7+",
      "8 ",
      "9+",
      "10+",
    ],
  );
});

test("advanced diff renderer expands tabs before writing terminal rows", async () => {
  const output = await renderAdvancedDiff({
    mode: "advanced",
    fileName: "example.ts",
    oldStr: "",
    newStr: "",
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { raw: "-\tconst before = true;" },
          { raw: "+\tconst after = true;" },
        ],
      },
    ],
  });

  expect(output).not.toContain("\t");
  expect(output).toContain("-     const before = true;");
  expect(output).toContain("+     const after = true;");
});
