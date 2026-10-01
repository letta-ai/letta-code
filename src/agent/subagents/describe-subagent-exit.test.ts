import { expect, test } from "bun:test";
import { describeSubagentExit } from "./subagent-stream";

test("a signal-killed child is reported by signal, with stderr as supporting detail", () => {
  const text = describeSubagentExit(
    null,
    "SIGKILL",
    "Loading skills...\nConnecting to listener...\n",
  );
  expect(text).toStartWith(
    "Subagent process was killed by SIGKILL before returning a result.",
  );
  expect(text).toContain("stderr tail:\nLoading skills...");
});

test("a non-zero exit without stderr names the code instead of an empty message", () => {
  expect(describeSubagentExit(1, null, "   ")).toBe(
    "Subagent process exited with code 1 before returning a result.",
  );
});

test("a long stderr is cut to its tail so startup noise cannot bury the exit reason", () => {
  const stderr = `${"x".repeat(5_000)}\nfinal line`;
  const text = describeSubagentExit(137, null, stderr);
  expect(text.length).toBeLessThan(2_200);
  expect(text).toContain("exited with code 137");
  expect(text).toEndWith("final line");
  expect(text).toContain("…");
});
