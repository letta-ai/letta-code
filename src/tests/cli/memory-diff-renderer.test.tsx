import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { MemoryDiffRenderer } from "../../cli/components/MemoryDiffRenderer";

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

async function renderMemoryDiff(
  args: Record<string, unknown>,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <MemoryDiffRenderer argsText={JSON.stringify(args)} toolName="memory" />,
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

test("memory diff renderer uses file_path for memory block names", async () => {
  const output = await renderMemoryDiff({
    command: "str_replace",
    reason: "Test memory display",
    file_path: "system/human.md",
    old_string: "before",
    new_string: "after",
  });

  expect(output).toContain("Updated memory block human.md");
  expect(output).not.toContain("Updated memory block unknown");
});
