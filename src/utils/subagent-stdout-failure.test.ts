import { describe, expect, test } from "bun:test";
import {
  isSubagentStdoutLostError,
  SUBAGENT_STDOUT_LOST_MARKER,
} from "@/utils/subagent-stdout-failure";

describe("isSubagentStdoutLostError", () => {
  test("matches the marker with surrounding stderr noise", () => {
    const stderr = `some warning\n${SUBAGENT_STDOUT_LOST_MARKER} (EPIPE)\n`;
    expect(isSubagentStdoutLostError(stderr)).toBe(true);
  });

  test("does not match unrelated stderr", () => {
    expect(isSubagentStdoutLostError("Subagent exited with code 1")).toBe(
      false,
    );
    expect(isSubagentStdoutLostError("")).toBe(false);
  });
});
