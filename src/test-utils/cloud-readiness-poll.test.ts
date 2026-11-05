import { expect, test } from "bun:test";
import {
  CloudRequestTimeoutError,
  pollCloudReadiness,
} from "./cloud-readiness-poll";
import { CloudReadinessError } from "./cloud-readiness-retry";

function clock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    wait: async (ms: number) => {
      time += ms;
    },
  };
}

test("a hung registration request can recover inside the original deadline", async () => {
  const timer = clock();
  const budgets: number[] = [];
  const connection = await pollCloudReadiness(
    "source registration",
    async (remaining) => {
      budgets.push(remaining);
      if (budgets.length === 1) {
        timer.advance(15_000);
        throw new CloudRequestTimeoutError(
          "GET /v1/environments",
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      }
      return "connection-1";
    },
    timer,
  );
  expect(connection).toBe("connection-1");
  expect(budgets).toEqual([60_000, 44_500]);
});

test("repeated request timeouts exhaust one deadline and retain the HTTP step", async () => {
  const timer = clock();
  const budgets: number[] = [];
  const error = new CloudRequestTimeoutError(
    "GET /v1/environments",
    new Error("timeout"),
  );
  await expect(
    pollCloudReadiness(
      "source registration",
      async (remaining) => {
        budgets.push(remaining);
        timer.advance(Math.min(15_000, remaining));
        throw error;
      },
      timer,
    ),
  ).rejects.toMatchObject({ cause: error });
  expect(budgets).toEqual([60_000, 44_500, 29_000, 13_500]);
  expect(timer.now()).toBe(60_000);
});

test("gateway failures retry, permanent errors and unrelated aborts fail immediately", async () => {
  for (const error of [
    new CloudReadinessError(401),
    new DOMException("cancelled", "AbortError"),
    new TypeError("fetch failed"),
  ]) {
    let attempts = 0;
    await expect(
      pollCloudReadiness(
        "registration",
        async () => {
          attempts++;
          throw error;
        },
        clock(),
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  }
  let attempts = 0;
  expect(
    await pollCloudReadiness(
      "registration",
      async () => {
        if (++attempts === 1) throw new CloudReadinessError(503);
        return "ready";
      },
      clock(),
    ),
  ).toBe("ready");
  expect(attempts).toBe(2);
});

test("a late successful probe cannot extend the readiness deadline", async () => {
  const timer = clock();
  let attempts = 0;
  await expect(
    pollCloudReadiness(
      "registration",
      async () => {
        attempts++;
        timer.advance(60_000);
        return "late";
      },
      timer,
    ),
  ).rejects.toThrow("registration timed out");
  expect(attempts).toBe(1);
});
