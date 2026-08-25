import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import {
  formatThinkingDuration,
  ReasoningMessage,
} from "./ReasoningMessageRich";

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

async function renderReasoning(expanded: boolean): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <ReasoningMessage
      line={{
        kind: "reasoning",
        id: "reasoning-1",
        text: "Inspecting the transcript",
        phase: "streaming",
      }}
      expanded={expanded}
    />,
    { stdout, debug: false, patchConsole: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();
  return stripAnsi(stdout.chunks.join(""));
}

test("streaming thinking stays one line while collapsed", async () => {
  const output = await renderReasoning(false);
  expect(output).toContain("Thinking… (ctrl+t to expand)");
  expect(output).not.toContain("Inspecting the transcript");
});

test("streaming thinking reveals content while expanded", async () => {
  const output = await renderReasoning(true);
  expect(output).toContain("Thinking… (ctrl+t to collapse)");
  expect(output).toContain("Inspecting the transcript");
});

test("formats completed thinking duration in seconds", () => {
  expect(formatThinkingDuration(400)).toBe("1 second");
  expect(formatThinkingDuration(3_600)).toBe("4 seconds");
});
