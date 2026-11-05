import { describe, expect, test } from "bun:test";
import { shouldUseNonInteractiveListenerOutput } from "@/cli/subcommands/listen-output-mode";

describe("listener output mode", () => {
  test("non-TTY stdout selects non-interactive output (no spinner UI)", () => {
    expect(shouldUseNonInteractiveListenerOutput(false, false, false)).toBe(
      true,
    );
    expect(shouldUseNonInteractiveListenerOutput(false, false, undefined)).toBe(
      true,
    );
  });

  test("a TTY without debug or lifecycle output uses the interactive UI", () => {
    expect(shouldUseNonInteractiveListenerOutput(false, false, true)).toBe(
      false,
    );
  });

  test("debug and lifecycle output stay non-interactive on a TTY", () => {
    expect(shouldUseNonInteractiveListenerOutput(true, false, true)).toBe(true);
    expect(shouldUseNonInteractiveListenerOutput(false, true, true)).toBe(true);
  });
});
