import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { InlineQuestionApproval } from "./InlineQuestionApproval";

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

async function renderQuestion(question: string): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    const instance = render(
      <InlineQuestionApproval
        questions={[
          {
            header: "Review plan",
            question,
            options: [
              { label: "Approve", description: "Proceed" },
              { label: "Revise", description: "Keep planning" },
            ],
            multiSelect: false,
            allowOther: false,
          },
        ]}
        onSubmit={() => {}}
        isFocused={false}
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
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("InlineQuestionApproval renders multiline markdown question text", async () => {
  const output = await renderQuestion(
    [
      "# Plan",
      "",
      "- Update `InlineQuestionApproval`",
      "- Keep options unchanged",
    ].join("\n"),
  );

  expect(output).toContain("Plan");
  expect(output).not.toContain("# Plan");
  expect(output).toContain("- Update InlineQuestionApproval");
  expect(output).toContain("Approve");
  expect(output).toContain("Revise");
});
