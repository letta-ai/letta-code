import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Box, render, Static, Text, useApp } from "ink";
import { useEffect, useState } from "react";

// Regression coverage for LET-13141: the patched Ink runtime must retain only
// a bounded tail of the committed static transcript, and overflow frames must
// not re-serialize the full static history per frame.

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

function makeItems(start: number, count: number, size: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${start + i}`,
    text: `${start + i}:${"s".repeat(size)}`,
  }));
}

// Live region is 10 rows tall while the terminal is 8 rows, so every frame
// takes Ink's overflow path (clearTerminal + fullStaticOutput + output).
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

const CLEAR_SCREEN = "[2J";

test("overflow frames rewrite only a bounded tail of the static transcript", async () => {
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

  // Commit 1 MB of static transcript in batches, 128 KB per batch. Items are
  // reassigned immutably: Static memoizes on the items array identity.
  for (let batch = 0; batch < 8; batch++) {
    items = [...items, ...makeItems(batch * 2, 2, 64 * 1024)];
    rerender(<OverflowHarness items={items} tick={batch + 1} />);
    await waitForRender();
  }

  const overflowWrites = stdout.chunks.filter((chunk) =>
    chunk.includes(CLEAR_SCREEN),
  );
  expect(overflowWrites.length).toBeGreaterThan(0);
  const largest = Math.max(...overflowWrites.map((chunk) => chunk.length));
  // Uncapped retention would rewrite the full ~1 MB transcript on the final
  // frames. The 256 KB retain cap plus the small live region must stay well
  // under 512 KB no matter how much static history accumulates.
  expect(largest).toBeLessThan(512 * 1024);

  unmount();
}, 20000);

test("static repaint after reset rewrites only the bounded tail", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const items = makeItems(0, 8, 96 * 1024); // ~768 KB of committed transcript
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

  render(<RepaintHarness />, {
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

  const repaintWrites = stdout.chunks.filter((chunk) =>
    chunk.includes(CLEAR_SCREEN),
  );
  expect(repaintWrites.length).toBeGreaterThan(0);
  const largest = Math.max(...repaintWrites.map((chunk) => chunk.length));
  expect(largest).toBeLessThan(512 * 1024);
}, 15000);
