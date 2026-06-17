import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render } from "ink";
import stripAnsi from "strip-ansi";
import { ModelListRow, type UiModel } from "@/cli/components/ModelSelector";

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

async function renderModelRow(model: UiModel, width: number): Promise<string> {
  const stdout = new CaptureStream(width) as CaptureStream & NodeJS.WriteStream;
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    const instance = render(
      <Box width={width}>
        <ModelListRow
          model={model}
          isSelected={false}
          isCurrent={false}
          showLock={false}
        />
      </Box>,
      {
        stdout,
        stdin: createInputStream(),
        debug: false,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const frame = stdout.chunks.join("");
    instance.unmount();
    instance.cleanup();
    return stripAnsi(frame);
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("ModelListRow truncates long descriptions instead of wrapping", async () => {
  const width = 64;
  const output = await renderModelRow(
    {
      id: "minimax-m3",
      handle: "minimax/MiniMax-M3",
      label: "MiniMax M3",
      description:
        "MiniMax's frontier M-series model for agentic reasoning, tool use, coding, multimodal chat input, and long-context tasks",
    },
    width,
  );

  const renderedLines = output
    .split("\n")
    .filter((line) => line.trim().length > 0);

  expect(renderedLines).toHaveLength(1);
  const renderedLine = renderedLines[0];
  expect(renderedLine).toBeDefined();
  if (!renderedLine) {
    throw new Error("Expected model row to render a line");
  }
  expect(renderedLine).toContain("MiniMax M3 ·");
  expect(renderedLine).toContain("…");
  expect(renderedLine).not.toContain("long-context tasks");
  expect(renderedLine.length).toBeLessThanOrEqual(width);
});
