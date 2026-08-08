import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import { useState } from "react";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

class CaptureStream extends Writable {
  columns = 100;
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

function TestInput({
  initialValue,
  initialCursor,
}: {
  initialValue: string;
  initialCursor: number;
}) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialCursor);

  return (
    <>
      <PasteAwareTextInput
        value={value}
        onChange={setValue}
        cursorPosition={cursor}
        onCursorMove={setCursor}
      />
      <Text>{`cursor:${cursor}`}</Text>
    </>
  );
}

async function renderInput(
  initialValue: string,
  interact?: (stdin: NodeJS.ReadStream) => void | Promise<void>,
  initialCursor = initialValue.length,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const instance = render(
    <TestInput initialValue={initialValue} initialCursor={initialCursor} />,
    {
      stdout,
      stdin,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  await interact?.(stdin);
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();

  return stdout.chunks.join("");
}

test("Ctrl+Left moves to previous word boundary, not one extra character", async () => {
  // Cursor starts at end of "hello world" (position 11).
  // Ctrl+Left should land at position 6 (start of "world"), not 5.
  const output = await renderInput("hello world", async (stdin) => {
    stdin.push("\x1b[1;5D");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(output).toContain("cursor:6");
  expect(output).not.toContain("cursor:5");
});

test("Ctrl+Right moves to next word boundary, not one extra character", async () => {
  // Cursor starts at position 0.
  // Ctrl+Right should land at position 6 (start of "world"), not 7.
  const output = await renderInput(
    "hello world",
    async (stdin) => {
      stdin.push("\x1b[1;5C");
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    0,
  );

  expect(output).toContain("cursor:6");
  expect(output).not.toContain("cursor:7");
});

test("Option+Left still moves to previous word boundary", async () => {
  const output = await renderInput("hello world", async (stdin) => {
    stdin.push("\x1b[1;3D");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(output).toContain("cursor:6");
});

test("Plain Left arrow still moves one character", async () => {
  const output = await renderInput("hello world", async (stdin) => {
    stdin.push("\x1b[D");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(output).toContain("cursor:10");
});
