import { afterEach, expect, test } from "bun:test";
import { getMonitorMaxTimeoutMs } from "./monitor-timeout";

const previous = process.env.LETTA_MONITOR_MAX_TIMEOUT_MS;
afterEach(() => {
  if (previous === undefined) delete process.env.LETTA_MONITOR_MAX_TIMEOUT_MS;
  else process.env.LETTA_MONITOR_MAX_TIMEOUT_MS = previous;
});

test("defaults to one hour when unset", () => {
  delete process.env.LETTA_MONITOR_MAX_TIMEOUT_MS;
  expect(getMonitorMaxTimeoutMs()).toBe(3_600_000);
});

test.each([
  ["86400000", 86_400_000],
  ["", 3_600_000],
  ["invalid", 3_600_000],
  ["86400000ms", 3_600_000],
  ["1.5", 3_600_000],
  ["0", 3_600_000],
  ["-86400000", 3_600_000],
  ["Infinity", 3_600_000],
  ["1000", 3_600_000],
  ["3600000", 3_600_000],
  ["604800000", 604_800_000],
  ["604800001", 604_800_000],
])("normalizes %s to %d ms", (value, expected) => {
  process.env.LETTA_MONITOR_MAX_TIMEOUT_MS = value;
  expect(getMonitorMaxTimeoutMs()).toBe(expected);
});
