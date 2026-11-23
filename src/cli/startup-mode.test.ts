import { describe, expect, test } from "bun:test";
import { hideHeadlessPrompt, isHeadlessStartup } from "@/cli/startup-mode";

describe("startup mode resolution", () => {
  test("non-TTY unknown positional without explicit headless flag stays out of headless mode", () => {
    expect(
      isHeadlessStartup({ prompt: false, run: false }, false, "hello"),
    ).toBe(false);
  });

  test("non-TTY startup without a positional uses stdin headless prompt transport", () => {
    expect(
      isHeadlessStartup({ prompt: false, run: false }, false, undefined),
    ).toBe(true);
  });

  test("-p keeps positional prompts in headless mode", () => {
    expect(
      isHeadlessStartup({ prompt: true, run: false }, false, "hello"),
    ).toBe(true);
  });

  test("--run keeps positional prompts in headless mode", () => {
    expect(
      isHeadlessStartup({ prompt: false, run: true }, false, "hello"),
    ).toBe(true);
  });

  test("TTY startup without a positional is interactive", () => {
    expect(
      isHeadlessStartup({ prompt: false, run: false }, true, undefined),
    ).toBe(false);
  });
});

describe("headless prompt process title", () => {
  test("leaves the process title alone for unknown commands and empty prompts", () => {
    const title = process.title;
    hideHeadlessPrompt({}, false, ["bun", "letta", "unknown"]);
    expect(process.title).toBe(title);
    hideHeadlessPrompt({ prompt: true }, false, ["bun", "letta", ""]);
    expect(process.title).toBe(title);
  });
});
