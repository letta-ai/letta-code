import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import { SleeptimeSelector } from "./SleeptimeSelector";

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

async function renderSleeptimeSelector(
  initialSettings: ReflectionSettings,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const instance = render(
    <SleeptimeSelector
      initialSettings={initialSettings}
      memfsEnabled
      onSave={() => {}}
      onCancel={() => {}}
    />,
    {
      stdout,
      stdin,
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

test("SleeptimeSelector renders the step count inline", async () => {
  const output = await renderSleeptimeSelector({
    trigger: "step-count",
    stepCount: 10,
    merge: "auto",
    mergeInstructions: "",
  });

  expect(output).toContain("Dream Settings");
  expect(output).toContain("Every [10█] steps");
  expect(output).toContain("On compaction");
  expect(output).toContain("Memory updates");
  expect(output).toContain("Apply automatically");
  expect(output).toContain("Agent reviews before applying");
  expect(output).not.toContain("Review instructions");
});

test("SleeptimeSelector shows review instructions only in explicit mode", async () => {
  const output = await renderSleeptimeSelector({
    trigger: "off",
    stepCount: 10,
    merge: "explicit",
    mergeInstructions: "Preserve exact wording.",
  });

  expect(output).toContain("Agent reviews before applying");
  expect(output).toContain("Review instructions");
  expect(output).toContain("[Preserve exact wording.]");
});
