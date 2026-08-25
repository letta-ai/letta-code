import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { setSystemRemindersVisible } from "@/cli/components/transcript-display-state";
import { StaticTranscript } from "./StaticTranscript";

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

test("system reminders default to hidden and ctrl+r toggles enabled reminders", async () => {
  setSystemRemindersVisible(false);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const instance = render(
    <StaticTranscript
      renderEpoch={0}
      items={[
        {
          kind: "user",
          id: "user-1",
          text: "<system-reminder>\nFirst instruction\nSecond instruction\n</system-reminder>\n\nVisible user question",
        },
      ]}
      columns={100}
      statusLinePrompt=">"
      showCompactionsEnabled={true}
      precomputedDiffs={new Map()}
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
  const hiddenOutput = stripAnsi(stdout.chunks.join(""));
  expect(hiddenOutput).not.toContain("System reminder");
  expect(hiddenOutput).not.toContain("First instruction");
  expect(hiddenOutput).toContain("Visible user question");

  const hiddenCtrlRStart = stdout.chunks.length;
  stdin.push("\x12");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stdout.chunks).toHaveLength(hiddenCtrlRStart);

  const visibleStart = stdout.chunks.length;
  setSystemRemindersVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const collapsedOutput = stripAnsi(stdout.chunks.slice(visibleStart).join(""));
  expect(collapsedOutput).toContain(
    "▸ System reminder · 2 lines (ctrl+r to expand)",
  );
  expect(collapsedOutput).not.toContain("First instruction");

  const expandedStart = stdout.chunks.length;
  stdin.push("\x12");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const expandedOutput = stripAnsi(stdout.chunks.slice(expandedStart).join(""));
  expect(expandedOutput).toContain("▾ System reminder (ctrl+r to collapse)");
  expect(expandedOutput).toContain("First instruction");

  const recollapsedStart = stdout.chunks.length;
  stdin.push("\x12");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stripAnsi(stdout.chunks.slice(recollapsedStart).join(""))).toContain(
    "▸ System reminder · 2 lines (ctrl+r to expand)",
  );

  instance.unmount();
  instance.cleanup();
  setSystemRemindersVisible(false);
});

test("ctrl+t expands and collapses thinking blocks", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const instance = render(
    <StaticTranscript
      renderEpoch={0}
      items={[
        {
          kind: "reasoning",
          id: "reasoning-1",
          text: "First thought\n\nSecond thought",
          phase: "finished",
          durationMs: 3_600,
        },
      ]}
      columns={100}
      statusLinePrompt=">"
      showCompactionsEnabled={true}
      precomputedDiffs={new Map()}
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
  const collapsedOutput = stripAnsi(stdout.chunks.join(""));
  expect(collapsedOutput).toContain("Thought for 4 seconds (ctrl+t to expand)");
  expect(collapsedOutput).not.toContain("First thought");

  const expandedStart = stdout.chunks.length;
  stdin.push("\x14");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const expandedOutput = stripAnsi(stdout.chunks.slice(expandedStart).join(""));
  expect(expandedOutput).toContain(
    "Thought for 4 seconds (ctrl+t to collapse)",
  );
  expect(expandedOutput).toContain("First thought");

  const recollapsedStart = stdout.chunks.length;
  stdin.push("\x14");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stripAnsi(stdout.chunks.slice(recollapsedStart).join(""))).toContain(
    "Thought for 4 seconds (ctrl+t to expand)",
  );

  instance.unmount();
  instance.cleanup();
});
