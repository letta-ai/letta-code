import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Box, render, Static, Text, useApp } from "ink";
import { useEffect, useState } from "react";

// Regression coverage for LET-13141: the patched Ink runtime must retain only
// a bounded tail of the committed static transcript for one-shot repaints.
// Overflow must not replay that tail, must not clear the screen (2J erases
// on-screen transcript rows in xterm-like terminals and copies every live
// frame into tmux history), must not append another live copy every
// streaming frame, and must skip identical frames.

const RETAIN_LIMIT = 2 * 1024 * 1024;
const OVERFLOW_SLACK = 256 * 1024;
const EARLY_MARKER = "EARLY-STATIC-MARKER";
const FILLER_MARKER = "FILLER-STATIC-MARKER";
const LATE_MARKER = "LATE-STATIC-MARKER";
const LIVE_TOP_MARKER = "STREAM-TOP-HIDDEN";
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

type VtOptions = {
  // tmux scroll-on-clear (its default): 2J first copies the viewport, up to
  // its last non-blank row, into scrollback.
  clearSavesToScrollback?: boolean;
  // Terminal height changes, applied before the chunk at index `at`.
  resizes?: Array<{ at: number; rows: number }>;
};

// Minimal VT model covering what Ink and log-update emit: text with deferred
// autowrap, LF (with ONLCR), CR, cursor up/column/position, and erase in
// line/display. By default 2J erases the viewport without copying it to
// scrollback (xterm.js); 3J wipes scrollback; rows that scroll off the top
// are preserved. Growing pulls history back into the top of the viewport
// (tmux, xterm.js with the cursor on the last row); shrinking drops blank
// rows below the cursor, then pushes top rows into history.
function replayVt(
  chunks: string[],
  rows: number,
  cols: number,
  options: VtOptions = {},
): { viewport: string; scrollback: string } {
  const scrollback: string[] = [];
  const lines: string[] = Array.from({ length: rows }, () => "");
  let row = 0;
  let col = 0;
  let wrapPending = false;

  const lineFeed = () => {
    wrapPending = false;
    if (row < lines.length - 1) {
      row += 1;
      return;
    }
    scrollback.push(lines.shift() ?? "");
    lines.push("");
  };

  const writeChar = (char: string) => {
    if (wrapPending) {
      col = 0;
      lineFeed();
    }
    const line = (lines[row] ?? "").padEnd(col, " ");
    lines[row] = line.slice(0, col) + char + line.slice(col + 1);
    if (col >= cols - 1) {
      wrapPending = true;
    } else {
      col += 1;
    }
  };

  const eraseDisplay = (mode: string) => {
    if (mode === "3") {
      scrollback.length = 0;
      return;
    }
    if (mode === "2") {
      if (options.clearSavesToScrollback) {
        let last = lines.length - 1;
        while (last >= 0 && (lines[last] ?? "").trim() === "") {
          last -= 1;
        }
        scrollback.push(...lines.slice(0, last + 1));
      }
      lines.fill("");
      return;
    }
    lines[row] = (lines[row] ?? "").slice(0, col);
    lines.fill("", row + 1);
  };

  const eraseLine = (mode: string) => {
    const line = lines[row] ?? "";
    if (mode === "2") {
      lines[row] = "";
    } else if (mode === "1") {
      lines[row] = " ".repeat(col + 1) + line.slice(col + 1);
    } else {
      lines[row] = line.slice(0, col);
    }
  };

  const resize = (next: number) => {
    wrapPending = false;
    while (lines.length < next) {
      const pulled = scrollback.pop();
      if (pulled === undefined) {
        lines.push("");
      } else {
        lines.unshift(pulled);
        row += 1;
      }
    }
    while (lines.length > next) {
      if (row < lines.length - 1 && lines[lines.length - 1] === "") {
        lines.pop();
      } else {
        scrollback.push(lines.shift() ?? "");
        row = Math.max(0, row - 1);
      }
    }
  };

  const applyCsi = (command: string | undefined, args: string) => {
    const count = Number.parseInt(args, 10) || 1;
    if (command === "A") {
      row = Math.max(0, row - count);
      wrapPending = false;
    } else if (command === "G") {
      col = Math.min(cols - 1, count - 1);
      wrapPending = false;
    } else if (command === "H" || command === "f") {
      const [targetRow, targetCol] = args.split(";");
      row = Math.min(lines.length - 1, (Number(targetRow) || 1) - 1);
      col = Math.min(cols - 1, (Number(targetCol) || 1) - 1);
      wrapPending = false;
    } else if (command === "J") {
      eraseDisplay(args);
    } else if (command === "K") {
      eraseLine(args);
    }
    // SGR and private modes (cursor visibility, synchronized output) do not
    // move text.
  };

  chunks.forEach((chunk, chunkIndex) => {
    for (const change of options.resizes ?? []) {
      if (change.at === chunkIndex) {
        resize(change.rows);
      }
    }
    let index = 0;
    while (index < chunk.length) {
      const char = chunk[index] ?? "";
      if (char === "\u001B" && chunk[index + 1] === "[") {
        let end = index + 2;
        while (end < chunk.length && !/[@-~]/.test(chunk[end] ?? "")) {
          end += 1;
        }
        applyCsi(chunk[end], chunk.slice(index + 2, end));
        index = end + 1;
        continue;
      }
      if (char === "\n") {
        col = 0;
        lineFeed();
      } else if (char === "\r") {
        col = 0;
        wrapPending = false;
      } else {
        writeChar(char);
      }
      index += 1;
    }
  });

  return {
    viewport: lines.join("\n"),
    scrollback: scrollback.join("\n"),
  };
}

function expectNoViewportClear(write: string) {
  expect(write).not.toContain(CLEAR_SCREEN);
  expect(write).not.toContain(CLEAR_SCROLLBACK);
}

function expectBoundedNewestTail(write: string) {
  expect(write).toContain(CLEAR_SCREEN);
  expect(write).toContain(CURSOR_HOME);
  expect(write).not.toContain(CLEAR_SCROLLBACK);
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
      <Box flexDirection="column">
        <Text>{LIVE_TOP_MARKER}</Text>
        {[
          "body 0",
          "body 1",
          "body 2",
          "body 3",
          "body 4",
          "body 5",
          "body 6",
          "body 7",
        ].map((label) => (
          <Text key={label}>{label}</Text>
        ))}
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
  expect(liveOnly).not.toContain(LIVE_TOP_MARKER);
  expect(liveOnly).not.toContain(EARLY_MARKER);
  expect(liveOnly).not.toContain(LATE_MARKER);
  expectNoViewportClear(stdout.chunks.join(""));

  const { viewport, scrollback } = replayVt(
    stdout.chunks,
    stdout.rows,
    stdout.columns,
  );
  const combined = `${scrollback}\n${viewport}`;
  expect(combined).toContain(EARLY_MARKER);
  expect(combined).toContain(LATE_MARKER);
  expect(viewport).toContain("live 5");
  expect(viewport).not.toContain(LIVE_TOP_MARKER);
  expect(viewport).not.toContain("live 4");
  expect(viewport).not.toContain("live 3");
  // Each overflow frame rewrites the previous (clipped) live frame in place;
  // those ticks must not accumulate in scrollback.
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
  expectNoViewportClear(stdout.chunks.join(""));
  expect(liveOnly).toContain("live 4");
  expect(liveOnly).not.toContain(LIVE_TOP_MARKER);
  expect(liveOnly).not.toContain(EARLY_MARKER);
  expect(liveOnly).not.toContain(FILLER_MARKER);
  expect(liveOnly).not.toContain(LATE_MARKER);
  expect(liveOnly.length).toBeLessThan(4 * 1024);

  unmount();
}, 45000);

function transcriptItems(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `transcript-${index}`,
    text: `T${String(index).padStart(2, "0")}`,
  }));
}

function liveRows(count: number, tick: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? `tick ${tick}` : `L${String(index).padStart(2, "0")}`,
  );
}

function RowsHarness({ items, live }: { items: Item[]; live: string[] }) {
  return (
    <>
      <Static items={items} style={{ flexDirection: "column" }}>
        {(item: Item) => <Text key={item.id}>{item.text}</Text>}
      </Static>
      <Box flexDirection="column">
        {live.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>
    </>
  );
}

function expectTranscriptRowsOnce(
  vt: { viewport: string; scrollback: string },
  items: Item[],
) {
  const screen = `${vt.scrollback}\n${vt.viewport}`;
  expect(
    items
      .map((item) => [item.text, countOccurrences(screen, item.text)] as const)
      .filter(([, count]) => count !== 1),
  ).toEqual([]);
  // No live-frame copy may land in history.
  expect(
    vt.scrollback
      .split("\n")
      .filter((line) => line.startsWith("L") || line.startsWith("tick")),
  ).toEqual([]);
}

test("live area jumping past the terminal height keeps on-screen transcript rows", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  stdout.rows = 12;
  const items = transcriptItems(30);
  const { rerender, unmount } = render(
    <RowsHarness items={items} live={liveRows(3, 0)} />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await waitForRender();

  // T22-T29 are still on screen above the 3-row live area when it jumps to
  // 20 rows in a 12-row terminal; then the live area shrinks back.
  rerender(<RowsHarness items={items} live={liveRows(20, 1)} />);
  await waitForRender();
  rerender(<RowsHarness items={items} live={liveRows(3, 2)} />);
  await waitForRender();
  unmount();

  const vt = replayVt(stdout.chunks, 12, stdout.columns);
  expectTranscriptRowsOnce(vt, items);
  expect(countOccurrences(vt.viewport, "tick 2")).toBe(1);
  expect(vt.viewport).not.toContain("tick 1");
  expect(vt.viewport).not.toContain("L09");
}, 20000);

test("growing the terminal while the live area overflows keeps transcript rows", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  stdout.rows = 12;
  const items = transcriptItems(30);
  const { rerender, unmount } = render(
    <RowsHarness items={items} live={liveRows(3, 0)} />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await waitForRender();
  rerender(<RowsHarness items={items} live={liveRows(20, 1)} />);
  await waitForRender();

  // Growing pulls T22-T29 back from history onto the screen above the live
  // area; later overflow frames must not erase them.
  const resizes = [{ at: stdout.chunks.length, rows: 20 }];
  stdout.rows = 20;
  stdout.emit("resize");
  await waitForRender();
  rerender(<RowsHarness items={items} live={liveRows(20, 2)} />);
  await waitForRender();
  unmount();

  const vt = replayVt(stdout.chunks, 12, stdout.columns, { resizes });
  expectTranscriptRowsOnce(vt, items);
  expect(countOccurrences(vt.viewport, "tick 2")).toBe(1);
  expect(vt.viewport).not.toContain("tick 1");
  expect(vt.viewport).toContain("L01");
}, 20000);

test("repeated overflow frames add no live copies to scrollback when clear saves the screen", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const items = transcriptItems(5);
  const { rerender, unmount } = render(
    <RowsHarness items={items} live={liveRows(10, 0)} />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await waitForRender();
  for (let tick = 1; tick <= 6; tick++) {
    rerender(<RowsHarness items={items} live={liveRows(10, tick)} />);
    await waitForRender();
  }
  unmount();

  // tmux (scroll-on-clear) copies the screen into history on every 2J.
  const vt = replayVt(stdout.chunks, stdout.rows, stdout.columns, {
    clearSavesToScrollback: true,
  });
  expectTranscriptRowsOnce(vt, items);
  const screen = `${vt.scrollback}\n${vt.viewport}`;
  expect(countOccurrences(screen, "L05")).toBe(1);
  expect(countOccurrences(screen, "tick 6")).toBe(1);
  expect(countOccurrences(screen, "tick 5")).toBe(0);
}, 20000);

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
