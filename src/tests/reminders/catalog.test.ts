import { describe, expect, test } from "bun:test";
import {
  SHARED_REMINDER_CATALOG,
  SHARED_REMINDER_IDS,
} from "../../reminders/catalog";
import {
  assertSharedReminderCoverage,
  sharedReminderProviders,
} from "../../reminders/engine";

describe("shared reminder catalog", () => {
  test("provider coverage matches catalog", () => {
    expect(() => assertSharedReminderCoverage()).not.toThrow();
  });

  test("catalog ids are unique", () => {
    const unique = new Set(SHARED_REMINDER_IDS);
    expect(unique.size).toBe(SHARED_REMINDER_IDS.length);
  });

  test("all reminders target all runtime modes", () => {
    for (const reminder of SHARED_REMINDER_CATALOG) {
      expect(reminder.modes).toContain("interactive");
      expect(reminder.modes).toContain("headless-one-shot");
      expect(reminder.modes).toContain("headless-bidirectional");
    }
  });

  test("provider ids and catalog ids stay in lockstep", () => {
    expect(Object.keys(sharedReminderProviders).sort()).toEqual(
      [...SHARED_REMINDER_IDS].sort(),
    );
  });
});
