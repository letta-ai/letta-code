import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { HelpDialog } from "./HelpDialog";

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

async function renderHelpDialog(
  interact?: (stdin: NodeJS.ReadStream) => void | Promise<void>,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const instance = render(<HelpDialog onClose={() => {}} />, {
    stdout,
    stdin,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await interact?.(stdin);
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();

  return stripAnsi(stdout.chunks.join(""));
}

test("HelpDialog renders its footer without raw Ink text", async () => {
  const output = await renderHelpDialog();

  expect(output).toContain("Letta Code v");
  expect(output).toContain("↑↓ scroll · ←→ page · Tab switch · Esc cancel");
});

test("HelpDialog keeps spacing between commands and descriptions", async () => {
  const output = await renderHelpDialog();

  expect(output).toContain("/remember Remember something");
});

test("HelpDialog scrolls commands with down arrow", async () => {
  const output = await renderHelpDialog(async (stdin) => {
    for (let i = 0; i < 10; i += 1) {
      stdin.push("\x1b[B");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  });

  expect(output).toContain("Page 2/");
});
