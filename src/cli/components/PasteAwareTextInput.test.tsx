import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

class OutputStream extends Writable {
  columns = 100;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
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

async function applyInput(
  sequences: string[],
  cursorPosition?: number,
): Promise<string> {
  const stdin = createInputStream();
  let value = "alpha beta";
  const instance = render(
    <PasteAwareTextInput
      value={value}
      onChange={(nextValue) => {
        value = nextValue;
      }}
      cursorPosition={cursorPosition}
    />,
    {
      stdout: new OutputStream() as OutputStream & NodeJS.WriteStream,
      stdin,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const sequence of sequences) {
      stdin.push(sequence);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return value;
  } finally {
    instance.unmount();
    instance.cleanup();
  }
}

test("Kitty Alt+Backspace deletes the previous word", async () => {
  expect(await applyInput(["\x1b[127;3u"])).toBe("alpha ");
});

test("Kitty Alt+b moves to the previous word before text insertion", async () => {
  expect(await applyInput(["\x1b[98;3u", "X"])).toBe("alpha Xbeta");
});

test("Kitty Alt+f moves to the next word before text insertion", async () => {
  expect(await applyInput(["\x1b[102;3u", "X"], 0)).toBe("alpha Xbeta");
});
