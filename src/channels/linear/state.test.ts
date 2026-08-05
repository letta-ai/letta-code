import { expect, test } from "bun:test";
import {
  createEmptyLinearPollState,
  MAX_LINEAR_SEEN_NOTIFICATIONS,
  normalizeLinearPollState,
} from "./state";

test("returns an empty baseline for malformed state", () => {
  expect(normalizeLinearPollState(null)).toEqual(createEmptyLinearPollState());
  expect(
    normalizeLinearPollState({ version: 99, seenNotificationIds: ["n-1"] }),
  ).toEqual(createEmptyLinearPollState());
  expect(
    normalizeLinearPollState({ version: 1, seenNotificationIds: "n-1" }),
  ).toEqual(createEmptyLinearPollState());
});

test("filters invalid IDs and bounds persisted notification history", () => {
  const ids = Array.from(
    { length: MAX_LINEAR_SEEN_NOTIFICATIONS + 5 },
    (_, index) => `notification-${index}`,
  );
  const normalized = normalizeLinearPollState({
    version: 1,
    initializedAt: "2026-08-03T20:00:00.000Z",
    seenNotificationIds: [null, ...ids, 42],
  });

  expect(normalized.seenNotificationIds).toHaveLength(
    MAX_LINEAR_SEEN_NOTIFICATIONS,
  );
  expect(normalized.seenNotificationIds[0]).toBe("notification-5");
  expect(normalized.seenNotificationIds.at(-1)).toBe(
    `notification-${MAX_LINEAR_SEEN_NOTIFICATIONS + 4}`,
  );
});
