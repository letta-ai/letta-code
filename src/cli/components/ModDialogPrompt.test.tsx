import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import type { ModDialog, ModEngine } from "@/mods/mod-engine";
import { ModDialogPrompt } from "./ModDialogPrompt";

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

// Only resolveDialog is exercised here; the prompt never calls anything else.
const noopEngine = { resolveDialog: () => {} } as unknown as ModEngine;

async function renderDialog(dialog: ModDialog): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    const instance = render(
      <ModDialogPrompt dialog={dialog} engine={noopEngine} />,
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
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("normalizes a bare question (no options) into a free-text dialog", async () => {
  const dialog: ModDialog = {
    id: "dialog-1",
    questions: [{ header: "Name", question: "What should I call it?" }],
    resolve: () => {},
  };

  const frame = await renderDialog(dialog);

  expect(frame).toContain("Name");
  expect(frame).toContain("What should I call it?");
  // options defaulted to [], allowOther undefined -> free-text row shown.
  expect(frame).toContain("Type something.");
});

test("renders options and hides the free-text row when allowOther is false", async () => {
  const dialog: ModDialog = {
    id: "dialog-2",
    questions: [
      {
        header: "Color",
        question: "Pick a color",
        options: [{ label: "red" }, { label: "blue" }],
        allowOther: false,
      },
    ],
    resolve: () => {},
  };

  const frame = await renderDialog(dialog);

  expect(frame).toContain("red");
  expect(frame).toContain("blue");
  expect(frame).not.toContain("Type something.");
});
