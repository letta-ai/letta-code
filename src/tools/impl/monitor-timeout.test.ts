import { afterEach, expect, test } from "bun:test";
import MonitorDescription from "@/tools/descriptions/Monitor.md";
import WatchPRDescription from "@/tools/descriptions/WatchPR.md";
import MonitorSchema from "@/tools/schemas/Monitor.json";
import {
  applyMonitorMaxTimeout,
  formatMonitorMaxTimeout,
  getMonitorMaxTimeoutMs,
} from "./monitor-timeout";

const previous = process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
afterEach(() => {
  if (previous === undefined)
    delete process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
  else process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS = previous;
});

test("defaults to one hour when unset", () => {
  delete process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
  expect(getMonitorMaxTimeoutMs()).toBe(3_600_000);
});

test.each([
  ["86400", 86_400_000],
  ["", 3_600_000],
  ["invalid", 3_600_000],
  ["86400s", 3_600_000],
  ["1.5", 3_600_000],
  ["0", 3_600_000],
  ["-86400", 3_600_000],
  ["Infinity", 3_600_000],
  ["60", 3_600_000],
  ["3600", 3_600_000],
  ["604800", 604_800_000],
  ["604801", 604_800_000],
  ["99999999999999999999", 3_600_000],
])("normalizes %s to %d ms", (value, expected) => {
  process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS = value;
  expect(getMonitorMaxTimeoutMs()).toBe(expected);
});

test.each([
  [3_600_000, "1 hour"],
  [5_400_000, "1.5 hours"],
  [86_400_000, "24 hours"],
  [172_800_000, "2 days"],
  [604_800_000, "7 days"],
])("formats %d ms as %s", (value, expected) => {
  expect(formatMonitorMaxTimeout(value)).toBe(expected);
});

test("renders the configured cap into Monitor and WatchPR text", () => {
  const texts = [
    MonitorDescription,
    WatchPRDescription,
    JSON.stringify(MonitorSchema),
  ].map((text) => applyMonitorMaxTimeout(text, 86_400_000));
  expect(texts[0]).toContain(
    "stops after 24 hours (this sandbox's monitor cap)",
  );
  expect(texts[1]).toContain(
    "stops after 24 hours (this sandbox's monitor cap)",
  );
  expect(texts[2]).toContain("still stops after 24 hours");
  expect(texts[2]).toContain("Maximum 24 hours.");
  for (const text of texts) {
    expect(text).not.toContain("{{MONITOR_MAX_TIMEOUT");
    expect(text).not.toContain("default 1 hour");
  }
});
