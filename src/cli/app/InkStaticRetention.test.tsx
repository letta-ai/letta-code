import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Box, render, Static, Text, useApp } from "ink";
import { useEffect, useState } from "react";

// Regression coverage for LET-13141: the patched Ink runtime must retain only
// a bounded tail of the committed static transcript for one-shot repaints.
// Overflow must not replay that tail, must not 3J, must not 2J-erase a new
// increment, must not append another live copy every streaming frame, and
// must skip identical frames.

const RETAIN_LIMIT = 2 * 1024 * 1024;
const OVERFLOW_SLACK = 256 * 1024;
const EARLY_MARKER = "EARLY-STATIC-MARKER";
const FILLER_MARKER = "FILLER-STATIC-MARKER";
const LATE_MARKER = "LATE-STATIC-MARKER";
const SGR_RESET = "\u001B[0m";
const CLEAR_SCREEN = "\u001B[2J";
const CLEAR_SCROLLBACK = "\u001B[3J";
const CURSOR_HOME = "\u001B[H";

class CaptureStream extends Writable {
  columns = 100;
  rows = 8;
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
  // onRender is throttled at 32ms; wait past the trailing edge.
  await new Promise((resolve) => setTimeout(resolve, 80));
}

type Item = { id: string; text: string };

function makeItems(
  start: number,
  count: number,
  size: number,
  marker?: string,
): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${start + i}`,
    text: `${marker ?? ""}${start + i}:${"s".repeat(size)}`,
  }));
}

function latestClearWrite(chunks: string[]): string {
  const writes = chunks.filter((chunk) => chunk.includes(CLEAR_SCREEN));
  expect(writes.length).toBeGreaterThan(0);
  const latest = writes[writes.length - 1];
  if (latest === undefined) {
    throw new Error("expected a clear-and-rewrite");
  }
  return latest;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
  return count;
}

// Minimal VT model matching the xterm.js facts this patch depends on:
// 2J erases the viewport and does not copy those cells into scrollback;
// 3J wipes scrollback; text that scrolls off the top is preserved.
function replayVt(
  chunks: string[],
  rows: number,
  cols: number,
): { viewport: string; scrollback: string } {
  const scrollback: string[] = [];
  const lines: string[] = Array.from({ length: rows }, () => "");
  let row = 0;
  let col = 0;

  const scrollUp = () => {
    scrollback.push(lines[0] ?? "");
    for (let index = 0; index < rows - 1; index++) {
      lines[index] = lines[index + 1] ?? "";
    }
    lines[rows - 1] = "";
    row = rows - 1;
    col = 0;
  };

  const writeChar = (char: string) => {
    if (char === "\n") {
      row += 1;
      col = 0;
      if (row >= rows) {
        scrollUp();
      }
      return;
    }
    if (char === "\r") {
      col = 0;
      return;
    }
    if (row >= rows) {
      scrollUp();
    }
    const line = lines[row] ?? "";
    const padded = line.padEnd(col, " ");
    lines[row] = padded.slice(0, col) + char + padded.slice(col + 1);
    col += 1;
    if (col >= cols) {
      col = 0;
      row += 1;
      if (row >= rows) {
        scrollUp();
      }
    }
  };

  const text = chunks.join("");
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001B" && text[index + 1] === "[") {
      let end = index + 2;
      while (end < text.length && !/[A-Za-z]/.test(text[end] ?? "")) {
        end += 1;
      }
      const command = text[end];
      const args = text.slice(index + 2, end);
      if (command === "J") {
        if (args === "3") {
          scrollback.length = 0;
        } else {
          for (let line = 0; line < rows; line++) {
            lines[line] = "";
          }
        }
      } else if (command === "H" || command === "f") {
        row = 0;
        col = 0;
      }
      index = end + 1;
      continue;
    }
    writeChar(text[index] ?? "");
    index += 1;
  }

  return {
    viewport: lines.join("\n"),
    scrollback: scrollback.join("\n"),
  };
}

function expectNoScrollbackWipe(write: string) {
  expect(write).toContain(CLEAR_SCREEN);
  expect(write).toContain(CURSOR_HOME);
  expect(write).not.toContain(CLEAR_SCROLLBACK);
}

function expectBoundedNewestTail(write: string) {
  expectNoScrollbackWipe(write);
  // retainStaticOutput prepends SGR reset at the seam so dropped prefix style
  // cannot leak. After 2J+H the one-shot repaint must start with that reset.
  expect(write).toContain(`${CLEAR_SCREEN}${CURSOR_HOME}${SGR_RESET}`);
  expect(write).toContain(LATE_MARKER);
  expect(write).not.toContain(EARLY_MARKER);
  expect(write.length).toBeLessThan(RETAIN_LIMIT + OVERFLOW_SLACK);
}

function OverflowHarness({ items, tick }: { items: Item[]; tick: number }) {
  return (
    <>
      <Static items={items} style={{ flexDirection: "column" }}>
        {(item: Item) => <Text key={item.id}>{item.text}</Text>}
      </Static>
      <Box height={10}>
        <Text>{`live ${tick}`}</Text>
      </Box>
    </>
  );
}

test("overflow scrolls new static into scrollback and replaces live in place", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  let items: Item[] = [];
  const { rerender, unmount } = render(
    <OverflowHarness items={items} tick={0} />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await waitForRender();

  items = [...items, ...makeItems(0, 1, 8, EARLY_MARKER)];
  rerender(<OverflowHarness items={items} tick={1} />);
  await waitForRender();

  items = [...items, ...makeItems(1, 1, 8, LATE_MARKER)];
  rerender(<OverflowHarness items={items} tick={2} />);
  await waitForRender();

  const writesAfterCommit = stdout.chunks.length;
  rerender(<OverflowHarness items={items} tick={2} />);
  await waitForRender();
  expect(stdout.chunks.length).toBe(writesAfterCommit);

  rerender(<OverflowHarness items={items} tick={3} />);
  await waitForRender();
  rerender(<OverflowHarness items={items} tick={4} />);
  await waitForRender();
  rerender(<OverflowHarness items={items} tick={5} />);
  await waitForRender();

  const liveOnly = stdout.chunks.slice(writesAfterCommit).join("");
  expect(liveOnly).toContain("live 5");
  expect(liveOnly).not.toContain(EARLY_MARKER);
  expect(liveOnly).not.toContain(LATE_MARKER);
  expect(liveOnly).not.toContain(CLEAR_SCROLLBACK);
  expectNoScrollbackWipe(liveOnly);

  const { viewport, scrollback } = replayVt(
    stdout.chunks,
    stdout.rows,
    stdout.columns,
  );
  const combined = `${scrollback}\n${viewport}`;
  expect(combined).toContain(EARLY_MARKER);
  expect(combined).toContain(LATE_MARKER);
  expect(viewport).toContain("live 5");
  expect(viewport).not.toContain("live 4");
  expect(viewport).not.toContain("live 3");
  // Live-only 2J replaces the previous tall frame; those ticks must not
  // accumulate in scrollback.
  expect(countOccurrences(combined, "live 3")).toBe(0);
  expect(countOccurrences(combined, "live 4")).toBe(0);
  expect(countOccurrences(combined, "live 5")).toBe(1);

  unmount();
}, 20000);

test("overflow frames do not replay the retained tail", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  let items: Item[] = [];
  const { rerender, unmount } = render(
    <OverflowHarness items={items} tick={0} />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await waitForRender();

  items = [...items, ...makeItems(0, 1, 256 * 1024, EARLY_MARKER)];
  rerender(<OverflowHarness items={items} tick={1} />);
  await waitForRender();

  items = [...items, ...makeItems(1, 1, RETAIN_LIMIT, FILLER_MARKER)];
  rerender(<OverflowHarness items={items} tick={2} />);
  await waitForRender();

  items = [...items, ...makeItems(2, 1, 256 * 1024, LATE_MARKER)];
  rerender(<OverflowHarness items={items} tick={3} />);
  await waitForRender();

  const lateWrites = stdout.chunks.filter((chunk) =>
    chunk.includes(LATE_MARKER),
  );
  expect(lateWrites.length).toBeGreaterThan(0);
  expect(lateWrites.some((chunk) => chunk.includes(FILLER_MARKER))).toBe(false);
  expect(lateWrites.some((chunk) => chunk.includes(EARLY_MARKER))).toBe(false);
  expect(stdout.chunks.some((chunk) => chunk.includes(CLEAR_SCROLLBACK))).toBe(
    false,
  );

  const writesAfterCommit = stdout.chunks.length;
  rerender(<OverflowHarness items={items} tick={3} />);
  await waitForRender();
  expect(stdout.chunks.length).toBe(writesAfterCommit);

  rerender(<OverflowHarness items={items} tick={4} />);
  await waitForRender();
  const liveOnly = stdout.chunks.slice(writesAfterCommit).join("");
  expectNoScrollbackWipe(liveOnly);
  expect(liveOnly).toContain("live 4");
  expect(liveOnly).not.toContain(EARLY_MARKER);
  expect(liveOnly).not.toContain(FILLER_MARKER);
  expect(liveOnly).not.toContain(LATE_MARKER);
  expect(liveOnly.length).toBeLessThan(4 * 1024);

  unmount();
}, 45000);

test("static repaint after reset rewrites only the bounded newest tail", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const items = [
    ...makeItems(0, 1, 256 * 1024, EARLY_MARKER),
    ...makeItems(1, 1, RETAIN_LIMIT, FILLER_MARKER),
    ...makeItems(2, 1, 256 * 1024, LATE_MARKER),
  ];
  let triggerReset: (() => void) | undefined;

  function RepaintHarness() {
    const app = useApp() as ReturnType<typeof useApp> & {
      resetStaticOutput?: () => void;
    };
    const [epoch, setEpoch] = useState(0);
    useEffect(() => {
      triggerReset = () => {
        app.resetStaticOutput?.();
        setEpoch((value) => value + 1);
      };
    }, [app.resetStaticOutput]);
    return (
      <>
        <Static key={epoch} items={items} style={{ flexDirection: "column" }}>
          {(item: Item) => <Text key={item.id}>{item.text}</Text>}
        </Static>
        <Box height={10}>
          <Text>live</Text>
        </Box>
      </>
    );
  }

  const { unmount } = render(<RepaintHarness />, {
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await waitForRender();
  expect(triggerReset).toBeDefined();

  stdout.chunks.length = 0;
  triggerReset?.();
  await waitForRender();

  expectBoundedNewestTail(latestClearWrite(stdout.chunks));

  unmount();
}, 45000);
