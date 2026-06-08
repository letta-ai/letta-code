import { describe, expect, test } from "bun:test";
import {
  sanitizeTerminalTitle,
  terminalTitleOsc,
} from "@/cli/helpers/terminal-title";

describe("terminal title writer helpers", () => {
  test("sanitizes terminal title", () => {
    const sanitized = sanitizeTerminalTitle(
      "  Project\t|\nWorking\x1b\x07\u009d\u009c |  Thread  ",
    );
    expect(sanitized).toBe("Project | Working | Thread");
  });

  test("strips invisible format chars from terminal title", () => {
    const sanitized = sanitizeTerminalTitle(
      "Pro\u202ej\u2066e\u200fc\u061ct\u200b \ufeffT\u2060itle",
    );
    expect(sanitized).toBe("Project Title");
  });

  test("truncates terminal title", () => {
    const input = "a".repeat(250);
    const sanitized = sanitizeTerminalTitle(input);
    expect(sanitized).toHaveLength(240);
  });

  test("truncation prefers visible char over pending space", () => {
    const input = `${"a".repeat(239)} b`;
    const sanitized = sanitizeTerminalTitle(input);
    expect(sanitized).toHaveLength(240);
    expect(sanitized.at(-1)).toBe("b");
  });

  test("writes OSC title with BEL terminator", () => {
    expect(terminalTitleOsc("hello")).toBe("\x1b]0;hello\x07");
  });
});
