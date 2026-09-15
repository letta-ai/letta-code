import { describe, expect, test } from "bun:test";
import { createMissedPongWatchdog } from "./missed-pong-watchdog";

describe("missed pong watchdog", () => {
  test("does not treat a delayed first interval as missed peer responses", () => {
    const watchdog = createMissedPongWatchdog(3);

    expect(watchdog.shouldTerminate(0)).toBe(false);
    watchdog.recordPing(120_000);

    expect(watchdog.shouldTerminate(0)).toBe(false);
  });

  test("terminates only after the configured number of unanswered probes", () => {
    const watchdog = createMissedPongWatchdog(3);

    for (const sentAt of [30_000, 60_000, 90_000]) {
      expect(watchdog.shouldTerminate(0)).toBe(false);
      watchdog.recordPing(sentAt);
    }

    expect(watchdog.shouldTerminate(0)).toBe(true);
  });

  test("a pong at or after the latest ping resets the missed-probe count", () => {
    const watchdog = createMissedPongWatchdog(3);

    watchdog.recordPing(30_000);
    watchdog.recordPing(60_000);
    expect(watchdog.shouldTerminate(60_000)).toBe(false);

    watchdog.recordPing(90_000);
    watchdog.recordPing(120_000);
    expect(watchdog.shouldTerminate(120_000)).toBe(false);
  });
});
