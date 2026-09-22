import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Box, render, Text } from "ink";
import stripAnsi from "strip-ansi";
import {
  setSystemRemindersVisible,
  setThinkingExpanded,
  toggleSystemReminderDisplay,
  toggleThinkingDisplay,
} from "@/cli/components/transcript-display-state";
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

async function waitForRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  setSystemRemindersVisible(false);
  setThinkingExpanded(false);
});

test("system reminder display changes repaint committed transcript rows", async () => {
  setSystemRemindersVisible(false);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
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
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await waitForRender();
  const hiddenOutput = stripAnsi(stdout.chunks.join(""));
  expect(hiddenOutput).not.toContain("System reminder");
  expect(hiddenOutput).not.toContain("First instruction");
  expect(hiddenOutput).toContain("Visible user question");

  const visibleStart = stdout.chunks.length;
  setSystemRemindersVisible(true);
  await waitForRender();
  const collapsedOutput = stripAnsi(stdout.chunks.slice(visibleStart).join(""));
  expect(collapsedOutput).toContain(
    "▸ System reminder · 2 lines (ctrl+r to expand)",
  );
  expect(collapsedOutput).not.toContain("First instruction");

  const expandedStart = stdout.chunks.length;
  toggleSystemReminderDisplay();
  await waitForRender();
  const expandedOutput = stripAnsi(stdout.chunks.slice(expandedStart).join(""));
  expect(expandedOutput).toContain("▾ System reminder (ctrl+r to collapse)");
  expect(expandedOutput).toContain("First instruction");

  const recollapsedStart = stdout.chunks.length;
  toggleSystemReminderDisplay();
  await waitForRender();
  expect(stripAnsi(stdout.chunks.slice(recollapsedStart).join(""))).toContain(
    "▸ System reminder · 2 lines (ctrl+r to expand)",
  );

  instance.unmount();
  instance.cleanup();
});

test("thinking display changes repaint committed transcript rows", async () => {
  setThinkingExpanded(false);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
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
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await waitForRender();
  const collapsedOutput = stripAnsi(stdout.chunks.join(""));
  expect(collapsedOutput).toContain("Thought for 4 seconds (ctrl+t to expand)");
  expect(collapsedOutput).not.toContain("First thought");

  const expandedStart = stdout.chunks.length;
  toggleThinkingDisplay();
  await waitForRender();
  const expandedOutput = stripAnsi(stdout.chunks.slice(expandedStart).join(""));
  expect(expandedOutput).toContain(
    "Thought for 4 seconds (ctrl+t to collapse)",
  );
  expect(expandedOutput).toContain("First thought");
  const repaintChunks = stdout.chunks.slice(expandedStart);
  const atomicRepaint = repaintChunks.find((chunk) =>
    chunk.includes("\u001B[2J"),
  );
  expect(atomicRepaint).toContain("\u001B[?2026h");
  expect(atomicRepaint).not.toContain("\u001B[3J");
  expect(atomicRepaint).toContain("First thought");
  expect(atomicRepaint).toContain("\u001B[?2026l");
  expect(repaintChunks.some((chunk) => chunk === "\u001B[2J\u001B[H")).toBe(
    false,
  );

  const recollapsedStart = stdout.chunks.length;
  toggleThinkingDisplay();
  await waitForRender();
  expect(stripAnsi(stdout.chunks.slice(recollapsedStart).join(""))).toContain(
    "Thought for 4 seconds (ctrl+t to expand)",
  );

  instance.unmount();
  instance.cleanup();
});

function OverflowTranscript({ overflow }: { overflow: boolean }) {
  return (
    <>
      <StaticTranscript
        renderEpoch={0}
        items={[
          {
            kind: "reasoning",
            id: "reasoning-overflow",
            text: "Reasoning body that must not return after recollapse",
            phase: "finished",
            durationMs: 3_600,
          },
        ]}
        columns={100}
        statusLinePrompt=">"
        showCompactionsEnabled={true}
        precomputedDiffs={new Map()}
      />
      {overflow && (
        <Box>
          <Text>{Array.from({ length: 10 }, () => "live").join("\n")}</Text>
        </Box>
      )}
    </>
  );
}

test("repeated transcript repaints replace Ink static output", async () => {
  setThinkingExpanded(false);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  stdout.rows = 6;
  const instance = render(<OverflowTranscript overflow={false} />, {
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await waitForRender();
  toggleThinkingDisplay();
  await waitForRender();
  toggleThinkingDisplay();
  await waitForRender();

  const overflowStart = stdout.chunks.length;
  instance.rerender(<OverflowTranscript overflow={true} />);
  await waitForRender();
  const overflowOutput = stripAnsi(stdout.chunks.slice(overflowStart).join(""));

  expect(overflowOutput.match(/Thought for 4 seconds/g)).toHaveLength(1);
  expect(overflowOutput).not.toContain(
    "Reasoning body that must not return after recollapse",
  );

  instance.unmount();
  instance.cleanup();
});
