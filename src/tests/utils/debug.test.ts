import { describe, expect, test } from "bun:test";
import { debugLogFile } from "../../utils/debug";

describe("debugLogFile tail buffering", () => {
  test("returns the in-memory tail for the current session", () => {
    debugLogFile.init("agent-debug-test", `session-${Date.now()}-a`);
    debugLogFile.appendLine("first line\n");
    debugLogFile.appendLine("second line\n");

    expect(debugLogFile.getTail(1)).toBe("second line");
    expect(debugLogFile.getTail(2)).toBe("first line\nsecond line");
  });

  test("init resets the buffered tail for a new session", () => {
    debugLogFile.init("agent-debug-test", `session-${Date.now()}-b`);

    expect(debugLogFile.getTail()).toBeUndefined();
  });
});
