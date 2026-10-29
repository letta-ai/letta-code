import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("stale turn catch ownership guard", () => {
  test("a displaced turn's catch returns before mutating shared turn state", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./use-conversation-loop.ts", import.meta.url)),
      "utf-8",
    );

    // The outer catch of processConversation.
    const catchAnchor = source.indexOf('"Unhandled conversation error: %s"');
    expect(catchAnchor).toBeGreaterThanOrEqual(0);

    // Turn-ownership witness (the same one finishTuiTurn uses): a
    // replacement turn overwrites abortControllerRef with its own
    // controller, so a stale turn sees a mismatch and must not touch the
    // replacement's state.
    const guardIndex = source.indexOf(
      "abortControllerRef.current !== turnAbortController",
      catchAnchor,
    );
    expect(guardIndex).toBeGreaterThan(catchAnchor);

    // The guard must precede every shared-state mutation in the catch:
    // cancelled-tool marking, the EAGER_CANCEL partial overlay, and the
    // generic error UI.
    const markIndex = source.indexOf(
      "markIncompleteToolsAsCancelled(",
      catchAnchor,
    );
    const overlayIndex = source.indexOf("overlayPartialResults(", catchAnchor);
    const errorUiIndex = source.indexOf("formatErrorDetails(", catchAnchor);
    expect(markIndex).toBeGreaterThan(guardIndex);
    expect(overlayIndex).toBeGreaterThan(guardIndex);
    expect(errorUiIndex).toBeGreaterThan(guardIndex);
  });
});
