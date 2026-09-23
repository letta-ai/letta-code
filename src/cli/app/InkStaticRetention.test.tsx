import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Box, render, Static, Text, useApp } from "ink";
import { useEffect, useState } from "react";

// Regression coverage for LET-13141: the patched Ink runtime must retain only
// a bounded tail of the committed static transcript, overflow frames must not
// re-serialize the full static history per frame, and overflow clears must not
// wipe emulator scrollback (no 3J).

const RETAIN_LIMIT = 8 * 1024 * 1024;
const OVERFLOW_SLACK = 256 * 1024;
const EARLY_MARKER = "EARLY-STATIC-MARKER";
const LATE_MARKER = "LATE-STATIC-MARKER";
const SGR_RESET = "\u001B[0m";
const CLEAR_SCREEN = "\u001B[2J";
const CLEAR_SCROLLBACK = "\u001B[3J";
const CURSOR_HOME = "\u001B[H";

class CaptureStream extends Writable {
  // Wide enough that each committed item stays a single line so yoga does not
  // wrap an 8+ MiB transcript into tens of thousands of rows.
  columns = 2 * 1024 * 1024;
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

function overflowWrites(chunks: string[]): string[] {
  return chunks.filter((chunk) => chunk.includes(CLEAR_SCREEN));
}

function latestOverflowWrite(chunks: string[]): string {
  const writes = overflowWrites(chunks);
  expect(writes.length).toBeGreaterThan(0);
  const latest = writes[writes.length - 1];
  if (latest === undefined) {
    throw new Error("expected an overflow rewrite");
  }
  return latest;
}

function expectBoundedNewestTail(write: string) {
  expect(write).toContain(CLEAR_SCREEN);
  expect(write).toContain(CURSOR_HOME);
  expect(write).not.toContain(CLEAR_SCROLLBACK);
  expect(write).toContain(SGR_RESET);
  expect(write).toContain(LATE_MARKER);
  expect(write).not.toContain(EARLY_MARKER);
  expect(write.length).toBeLessThan(RETAIN_LIMIT + OVERFLOW_SLACK);
}

// Live region is 10 rows tall while the terminal is 8 rows, so every frame
// takes Ink's overflow path (2J+H + fullStaticOutput + output).
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

test("overflow frames rewrite only a bounded newest tail without wiping scrollback", async () => {
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

  // Commit ~10 MiB of static transcript so retention must drop the prefix.
  // Wide columns keep wrapping cheap; items are reassigned immutably because
  // Static memoizes on the items array identity.
  items = [...items, ...makeItems(0, 1, 512 * 1024, EARLY_MARKER)];
  rerender(<OverflowHarness items={items} tick={1} />);
  await waitForRender();

  for (let batch = 0; batch < 8; batch++) {
    items = [...items, ...makeItems(1 + batch, 1, 1024 * 1024)];
    rerender(<OverflowHarness items={items} tick={batch + 2} />);
    await waitForRender();
  }

  items = [...items, ...makeItems(9, 1, 512 * 1024, LATE_MARKER)];
  rerender(<OverflowHarness items={items} tick={10} />);
  await waitForRender();

  const latest = latestOverflowWrite(stdout.chunks);
  expectBoundedNewestTail(latest);

  const writesAfterCommit = overflowWrites(stdout.chunks).length;
  rerender(<OverflowHarness items={items} tick={10} />);
  await waitForRender();
  rerender(<OverflowHarness items={items} tick={10} />);
  await waitForRender();
  expect(overflowWrites(stdout.chunks).length).toBe(writesAfterCommit);

  unmount();
}, 60000);

test("static repaint after reset rewrites only the bounded newest tail", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const items = [
    ...makeItems(0, 1, 512 * 1024, EARLY_MARKER),
    ...makeItems(1, 8, 1024 * 1024),
    ...makeItems(9, 1, 512 * 1024, LATE_MARKER),
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

  expectBoundedNewestTail(latestOverflowWrite(stdout.chunks));

  unmount();
}, 60000);
