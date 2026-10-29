import { expect, test } from "bun:test";
import { retryCursorStart } from "./cursor-start-retry";

const rejection = new Error(
  'AI Model Not Found Model name is not valid: "claude-haiku-5-5"',
);

test("retries the provider rejection with bounded short backoff and unchanged input", async () => {
  const delays: number[] = [];
  let calls = 0;
  const start = async () => {
    if (++calls < 3) throw rejection;
    return "same model accepted";
  };
  expect(
    await retryCursorStart(
      start,
      () => true,
      async (ms) => {
        delays.push(ms);
      },
    ),
  ).toBe("same model accepted");
  expect(calls).toBe(3);
  expect(delays).toEqual([500, 1000]);
});

test("fails after three model rejections with the original error", async () => {
  let calls = 0;
  await expect(
    retryCursorStart(
      async () => {
        calls++;
        throw rejection;
      },
      () => true,
      async () => {},
    ),
  ).rejects.toBe(rejection);
  expect(calls).toBe(3);
});

for (const message of [
  "Unauthorized",
  "Connection reset",
  "Cannot use this model: invalid",
  "Model name is not valid: other",
]) {
  test(`does not retry ${message}`, async () => {
    let calls = 0;
    const error = new Error(message);
    await expect(
      retryCursorStart(
        async () => {
          calls++;
          throw error;
        },
        () => true,
        async () => {
          throw new Error("unexpected delay");
        },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });
}

test("never replays after tools execute or cancellation", async () => {
  let calls = 0;
  await expect(
    retryCursorStart(
      async () => {
        calls++;
        throw rejection;
      },
      () => false,
    ),
  ).rejects.toBe(rejection);
  expect(calls).toBe(1);
  let allowed = true;
  await expect(
    retryCursorStart(
      async () => {
        calls++;
        throw rejection;
      },
      () => allowed,
      async () => {
        allowed = false;
      },
    ),
  ).rejects.toBe(rejection);
  expect(calls).toBe(2);
});
