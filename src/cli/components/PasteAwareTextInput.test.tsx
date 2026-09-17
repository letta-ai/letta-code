import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import chalk from "chalk";
import { render } from "ink";
import { useState } from "react";
import stripAnsi from "strip-ansi";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

/**
 * Regression coverage for letta-code #4493: an IME (Input Method Editor)
 * commit — or any terminal write — can reach the process as several stdin
 * reads inside one `'readable'` tick. Ink emits one `input` event per read, so
 * the composer sees multiple `useInput` events before React flushes the
 * passive effects of the first render. The value-sync effect in
 * `PasteAwareTextInput` then ran with an older `value`, clamped the caret to
 * that shorter length and re-applied the older display value over the newer
 * one — caret one short, middle chunks dropped.
 *
 * The fake stdin below reproduces the read pattern deterministically without
 * an IME or a TTY: `read()` yields the queued chunks one at a time within a
 * single `'readable'` emission.
 */
class MultiReadStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];

  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  read(): string | null {
    return this.queue.length > 0 ? (this.queue.shift() as string) : null;
  }

  /** Deliver `chunks` so that `read()` yields them one at a time in one tick. */
  pushReads(chunks: string[]): void {
    this.queue.push(...chunks);
    this.emit("readable");
  }
}

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  frames: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.frames.push(String(chunk));
    callback();
  }
}

const INVERSE_ON = "\u001b[7m";

/**
 * Caret position as the user sees it: the text input renders the character
 * under the caret (or a trailing space) in inverse video. Returns the number
 * of characters before that span in the last frame that drew the input.
 */
function renderedCaret(frames: string[]): number | null {
  const frame = [...frames].reverse().find((f) => f.includes(INVERSE_ON));
  if (!frame) return null;
  return Array.from(
    stripAnsi(frame.slice(0, frame.indexOf(INVERSE_ON))).replace(/\r?\n/g, ""),
  ).length;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

interface Observed {
  value: string;
  /** Caret offset the input reported to the parent (`onCursorMove`). */
  caret: number | null;
  /** Caret offset actually drawn in the last frame. */
  renderedCaret: number | null;
}

function Harness({ observed }: { observed: Observed }) {
  const [value, setValue] = useState("");
  return (
    <PasteAwareTextInput
      value={value}
      onChange={(next) => {
        observed.value = next;
        setValue(next);
      }}
      onSubmit={() => {}}
      onCursorMove={(offset) => {
        observed.caret = offset;
      }}
      focus
    />
  );
}

/**
 * Renders the real composer input under Ink and feeds `groups` of stdin reads,
 * one group per tick. Returns the parent-observed value and caret.
 */
async function typeInReads(groups: string[][]): Promise<Observed> {
  const observed: Observed = { value: "", caret: null, renderedCaret: null };
  const stdin = new MultiReadStdin();
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  // Force styled output so the inverse-video caret is visible in captured frames.
  const previousLevel = chalk.level;
  chalk.level = 1;
  const instance = render(<Harness observed={observed} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    stderr: stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    await tick();
    for (const group of groups) {
      stdin.pushReads(group);
      await tick();
    }
    await tick();
    observed.renderedCaret = renderedCaret(stdout.frames);
    return observed;
  } finally {
    instance.unmount();
    chalk.level = previousLevel;
  }
}

describe("PasteAwareTextInput multi-read input commits (#4493)", () => {
  test("keeps the caret at the end when one commit arrives as two reads in one tick", async () => {
    // Reporter's first log: 日本語 delivered as 日本 + 語 within one tick.
    const observed = await typeInReads([["日本", "語"]]);
    expect(observed.value).toBe("日本語");
    expect(observed.caret).toBe(3);
    expect(observed.renderedCaret).toBe(3);
  });

  test("preserves every chunk when one commit arrives as three reads in one tick", async () => {
    // Reporter's second log: the middle chunk used to be dropped.
    const chunks = ["日本", "語の", "入力中に変換がおかしくなるのが問題だ"];
    const observed = await typeInReads([chunks]);
    expect(observed.value).toBe(chunks.join(""));
    expect(observed.caret).toBe(chunks.join("").length);
    expect(observed.renderedCaret).toBe(chunks.join("").length);
  });

  test("is independent of IME/CJK input: ASCII split across two reads in one tick", async () => {
    const observed = await typeInReads([["ab", "c"]]);
    expect(observed.value).toBe("abc");
    expect(observed.caret).toBe(3);
    expect(observed.renderedCaret).toBe(3);
  });

  test("control: the same chunks in separate ticks were always intact", async () => {
    const observed = await typeInReads([["日本"], ["語"]]);
    expect(observed.value).toBe("日本語");
    expect(observed.caret).toBe(3);
    expect(observed.renderedCaret).toBe(3);
  });
});
