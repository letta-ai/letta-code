import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { ComponentProps } from "react";
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

type QuestionsProp = ComponentProps<typeof InlineQuestionApproval>["questions"];

async function renderWithQuestions(questions: QuestionsProp): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    const instance = render(
      <InlineQuestionApproval
        questions={questions}
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

async function renderQuestion(question: string): Promise<string> {
  return renderWithQuestions([
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
  ]);
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

test("InlineQuestionApproval coerces non-array `options` instead of throwing (defense-in-depth)", async () => {
  // Regression: a malformed AskUserQuestion payload can carry `options` as a
  // non-iterable value (e.g. {} or a number). Spreading it would throw
  // "...iterable not be null or undefined" / "object is not iterable" and brick
  // the TUI. The component must coerce to an empty array and keep rendering.
  const renderWithOptions = (options: unknown) =>
    renderWithQuestions([
      {
        header: "H",
        question: "Q?",
        options,
        multiSelect: false,
      },
    ] as QuestionsProp);

  for (const bad of [undefined, null, { a: 1 }, 42, "nope"]) {
    const output = await renderWithOptions(bad);
    expect(typeof output).toBe("string");
  }
});
