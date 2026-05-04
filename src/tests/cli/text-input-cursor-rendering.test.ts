import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const vendorPath = fileURLToPath(
  new URL("../../../vendor/ink-text-input/build/index.js", import.meta.url),
);

describe("vendored ink-text-input cursor rendering", () => {
  test("uses an internal sentinel instead of rendering NBSP cursor cells", () => {
    const source = readFileSync(vendorPath, "utf8");

    expect(source).toContain("CURSOR_SENTINEL");
    expect(source).toContain("replaceAll(CURSOR_SENTINEL, chalk.inverse(' '))");
    expect(source).not.toContain("chalk.inverse('\\u00A0')");
  });

  test("sentinel survives wrap-ansi trim before converting back to ASCII space", async () => {
    const { default: wrapAnsi } = await import("wrap-ansi");
    const cursorSentinel = "\u{10FFFD}";

    expect(wrapAnsi("abc ", 3, { trim: true, hard: true })).toBe("abc");

    const wrapped = wrapAnsi(`abc${cursorSentinel}`, 3, {
      trim: true,
      hard: true,
    }).replaceAll(cursorSentinel, " ");

    expect(wrapped).toBe("abc\n ");
    expect(wrapped).not.toContain("\u00A0");
  });
});
