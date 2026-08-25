import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import {
  detectOptionWordDirection,
  PasteAwareTextInput,
} from "@/cli/components/PasteAwareTextInput";

const ESC = "\u001b";

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
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

const existingNavigationSequences: ReadonlyArray<
  readonly [string, "left" | "right"]
> = [
  [`${ESC}b`, "left"],
  [`${ESC}B`, "left"],
  [`${ESC}f`, "right"],
  [`${ESC}F`, "right"],
  ...[3, 4, 7, 8, 9].flatMap(
    (modifier) =>
      [
        [`${ESC}[${modifier}D`, "left"],
        [`${ESC}[${modifier}C`, "right"],
        [`${ESC}[1;${modifier}D`, "left"],
        [`${ESC}[1;${modifier}C`, "right"],
      ] as const,
  ),
];

describe("detectOptionWordDirection", () => {
  test.each([
    [`${ESC}[98;3u`, "left"],
    [`${ESC}[102;3u`, "right"],
  ] as const)(
    "recognizes observed CSI-u Alt+b/f input: %s",
    (sequence, direction) => {
      expect(detectOptionWordDirection(sequence)).toBe(direction);
    },
  );

  test.each([
    [`${ESC}[98;3:1u`, "left"],
    [`${ESC}[98;3:2u`, "left"],
    [`${ESC}[102;3:1u`, "right"],
    [`${ESC}[102;3:2u`, "right"],
  ] as const)(
    "accepts CSI-u press and repeat events: %s",
    (sequence, direction) => {
      expect(detectOptionWordDirection(sequence)).toBe(direction);
    },
  );

  test.each([
    `${ESC}[98;3:3u`,
    `${ESC}[102;3:3u`,
    `${ESC}[98;3:4u`,
    `${ESC}[102;3:0u`,
  ])("rejects CSI-u release and unknown events: %s", (sequence) => {
    expect(detectOptionWordDirection(sequence)).toBeNull();
  });

  test.each([
    `${ESC}[97;3u`,
    `${ESC}[103;3u`,
    `${ESC}[98;1u`,
    `${ESC}[98;2u`,
    `${ESC}[98;5u`,
    `${ESC}[98;35u`,
  ])("rejects wrong codepoints and non-Alt modifiers: %s", (sequence) => {
    expect(detectOptionWordDirection(sequence)).toBeNull();
  });

  test.each(existingNavigationSequences)(
    "preserves existing navigation sequences: %s",
    (sequence, direction) => {
      expect(detectOptionWordDirection(sequence)).toBe(direction);
    },
  );

  test.each([
    [`${ESC}[98;67u`, "left"], // Alt + Caps Lock
    [`${ESC}[102;131u`, "right"], // Alt + Num Lock
    [`${ESC}[98;195u`, "left"], // Alt + Caps Lock + Num Lock
  ] as const)("normalizes Kitty lock bits: %s", (sequence, direction) => {
    expect(detectOptionWordDirection(sequence)).toBe(direction);
  });

  test("handles CSI-u through the raw input path without inserting b or f", async () => {
    const stdin = createInputStream();
    const stdout = new CaptureStream();
    const changes: string[] = [];
    const cursorOffsets: number[] = [];
    let resolveCursorMove: (() => void) | undefined;
    const cursorMoved = new Promise<void>((resolve) => {
      resolveCursorMove = resolve;
    });
    const instance = render(
      <PasteAwareTextInput
        value="alpha beta"
        onChange={(value) => changes.push(value)}
        cursorPosition={10}
        onCursorMove={(position) => {
          cursorOffsets.push(position);
          if (position === 6) resolveCursorMove?.();
        }}
      />,
      {
        stdout: stdout as CaptureStream & NodeJS.WriteStream,
        stdin,
        debug: false,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    stdin.push(`${ESC}[98;3u`);
    await Promise.race([
      cursorMoved,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("CSI-u cursor move timed out")),
          1000,
        ),
      ),
    ]);
    instance.unmount();
    instance.cleanup();

    expect(changes).toEqual([]);
    expect(cursorOffsets).toContain(6);
  });
});
