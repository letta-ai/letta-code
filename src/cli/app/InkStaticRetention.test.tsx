import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Box, render, Static, Text, useApp } from "ink";
import { useEffect, useState } from "react";

// Regression coverage for LET-13141: the patched Ink runtime must retain only
// a bounded tail of the committed static transcript for one-shot repaints,
// overflow frames must not replay that tail (or wipe scrollback with 3J), and
// identical overflow frames must not write.

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

// Live region is 10 rows tall while the terminal is 8 rows, so every frame
// takes Ink's overflow path (new increment + 2J+H + live output).
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

test("overflow frames do not replay the retained tail or wipe scrollback", async () => {
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

  // Commit ~2.5 MiB of static transcript so a tail-replay bug would include
  // the filler. Items are reassigned immutably because Static memoizes on the
  // items array identity.
  items = [...items, ...makeItems(0, 1, 256 * 1024, EARLY_MARKER)];
  rerender(<OverflowHarness items={items} tick={1} />);
  await waitForRender();

  items = [...items, ...makeItems(1, 1, RETAIN_LIMIT, FILLER_MARKER)];
  rerender(<OverflowHarness items={items} tick={2} />);
  await waitForRender();

  items = [...items, ...makeItems(2, 1, 256 * 1024, LATE_MARKER)];
  rerender(<OverflowHarness items={items} tick={3} />);
  await waitForRender();

  const afterCommit = latestOverflowWrite(stdout.chunks);
  expectNoScrollbackWipe(afterCommit);
  // This frame's new increment may be present; previously retained items must
  // not be replayed into the overflow write.
  expect(afterCommit).toContain(LATE_MARKER);
  expect(afterCommit).not.toContain(EARLY_MARKER);
  expect(afterCommit).not.toContain(FILLER_MARKER);
  expect(afterCommit.length).toBeLessThan(512 * 1024);

  const writesAfterCommit = overflowWrites(stdout.chunks).length;
  rerender(<OverflowHarness items={items} tick={3} />);
  await waitForRender();
  rerender(<OverflowHarness items={items} tick={3} />);
  await waitForRender();
  expect(overflowWrites(stdout.chunks).length).toBe(writesAfterCommit);

  rerender(<OverflowHarness items={items} tick={4} />);
  await waitForRender();
  const liveOnly = latestOverflowWrite(stdout.chunks);
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

  expectBoundedNewestTail(latestOverflowWrite(stdout.chunks));

  unmount();
}, 45000);
