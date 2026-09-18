import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { useState } from "react";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

// Regression coverage for CJK IME input.
//
// macOS terminals deliver a single "convert and commit" result as several
// stdin reads in the same tick (e.g. `日本` then `語`). Ink dispatched each read
// as its own input event, so the text input handled a burst of separate events
// and ended up dropping a chunk or leaving the caret one position before the
// end.

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

interface ChunkedInputStream extends NodeJS.ReadStream {
  queue: (chunk: string) => void;
}

// Minimal TTY-like stdin whose `read()` returns one queued chunk per call.
function createChunkedInputStream(): ChunkedInputStream {
  const input = new Readable({ read() {} }) as ChunkedInputStream;
  const pending: string[] = [];
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  input.read = (() =>
    pending.length > 0 ? pending.shift() : null) as NodeJS.ReadStream["read"];
  input.queue = (chunk: string) => {
    pending.push(chunk);
    input.emit("readable");
  };
  return input;
}

interface Harness {
  value: () => string;
  cursor: () => number;
  setValue: (value: string) => void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withHarness(
  interact: (
    harness: Harness,
    stdin: ChunkedInputStream,
  ) => Promise<void> | void,
): Promise<void> {
  const state = { value: "", cursor: -1 };
  let setValueExternal: (value: string) => void = () => {};

  function HarnessComponent() {
    const [value, setValue] = useState("");
    state.value = value;
    setValueExternal = setValue;
    return (
      <PasteAwareTextInput
        value={value}
        onChange={(next) => {
          state.value = next;
          setValue(next);
        }}
        onCursorMove={(position) => {
          state.cursor = position;
        }}
      />
    );
  }

  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createChunkedInputStream();
  const instance = render(<HarnessComponent />, {
    stdout,
    stdin,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    await wait(30);
    await interact(
      {
        value: () => state.value,
        cursor: () => state.cursor,
        setValue: (next) => setValueExternal(next),
      },
      stdin,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
}

test("split IME commit keeps every chunk and the caret at the end", async () => {
  await withHarness(async (harness, stdin) => {
    // One logical commit (`日本語`) delivered as two reads in the same tick.
    stdin.queue("日本");
    stdin.queue("語");
    await wait(40);

    expect(harness.value()).toBe("日本語");
    expect(harness.cursor()).toBe(3);
  });
});

test("three-way split IME commit keeps every chunk and the caret at the end", async () => {
  await withHarness(async (harness, stdin) => {
    stdin.queue("日本");
    stdin.queue("語の");
    stdin.queue("入力中");
    await wait(40);

    expect(harness.value()).toBe("日本語の入力中");
    expect(harness.cursor()).toBe(7);
  });
});

test("external value clear resyncs the caret to the start", async () => {
  await withHarness(async (harness, stdin) => {
    stdin.queue("日本語");
    await wait(40);
    expect(harness.cursor()).toBe(3);

    harness.setValue("");
    await wait(40);

    expect(harness.value()).toBe("");
    expect(harness.cursor()).toBe(0);
  });
});

test("control keys between text preserve order", async () => {
  await withHarness(async (harness, stdin) => {
    // `ab` is buffered; the right-arrow control event must flush it first, and
    // `cd` must not be merged into the buffered text out of order.
    stdin.queue("ab");
    stdin.queue("\x1b[C");
    stdin.queue("cd");
    await wait(40);

    expect(harness.value()).toBe("abcd");
    expect(harness.cursor()).toBe(4);
  });
});
