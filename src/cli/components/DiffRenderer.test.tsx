import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";
import { EditRenderer, MultiEditRenderer, WriteRenderer } from "./DiffRenderer";

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

async function renderDiff(element: ReactElement): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(element, {
    stdout,
    stdin: createInputStream(),
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();

  return stripAnsi(stdout.chunks.join(""));
}

test("simple diff renderers can omit their redundant completion headers", async () => {
  const outputs = await Promise.all([
    renderDiff(
      <EditRenderer
        filePath="/tmp/example.ts"
        oldString="const before = true;"
        newString="const after = true;"
        showHeader={false}
        showLineNumbers={false}
      />,
    ),
    renderDiff(
      <MultiEditRenderer
        filePath="/tmp/example.ts"
        edits={[{ old_string: "before", new_string: "after" }]}
        showHeader={false}
        showLineNumbers={false}
      />,
    ),
    renderDiff(
      <WriteRenderer
        filePath="/tmp/example.ts"
        content="const value = true;"
        showHeader={false}
      />,
    ),
  ]);

  expect(outputs[0]).toContain("const after = true;");
  expect(outputs[0]).not.toContain("Updated");
  expect(outputs[1]).toContain("after");
  expect(outputs[1]).not.toContain("Updated");
  expect(outputs[2]).toContain("const value = true;");
  expect(outputs[2]).not.toContain("Wrote");
});
