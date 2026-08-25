import { describe, expect, test } from "bun:test";
import { detectOptionWordDirection } from "@/cli/components/PasteAwareTextInput";

const ESC = "\u001b";

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

  test.each([
    [`${ESC}b`, "left"],
    [`${ESC}B`, "left"],
    [`${ESC}f`, "right"],
    [`${ESC}F`, "right"],
    [`${ESC}[1;3D`, "left"],
    [`${ESC}[1;3C`, "right"],
  ] as const)(
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
});
