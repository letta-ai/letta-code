import { expect, test } from "bun:test";
import {
  formatScheduledTaskPrompt,
  parseScheduledTaskPrompt,
  stripNonScheduledSystemReminders,
} from "./scheduled-task-prompt";

test("parses a wrapped scheduled fire and an older unwrapped fire alike", () => {
  const time = new Date("2026-01-01T00:00:00Z");
  const wrapped = formatScheduledTaskPrompt({
    name: "Daily status",
    timezone: "UTC",
    scheduledFor: time,
    currentTime: time,
    recurrence: { type: "recurring", cron: "0 0 * * *", fireNumber: 2 },
    prompt: "Summarize open items.\nInclude owners.",
  });
  expect(wrapped).toStartWith(
    '<system-reminder>\nScheduled task "Daily status"',
  );
  expect(wrapped).toEndWith("\n</system-reminder>");

  const parsed = parseScheduledTaskPrompt(wrapped);
  expect(parsed).toMatchObject({
    name: "Daily status",
    recurrence: { type: "recurring", cron: "0 0 * * *", fireNumber: 2 },
    prompt: "Summarize open items.\nInclude owners.",
  });
  const legacy = wrapped.split("\n").slice(1, -1).join("\n");
  expect(parseScheduledTaskPrompt(legacy)).toEqual(parsed);
  expect(
    stripNonScheduledSystemReminders(
      `${wrapped}\n<system-reminder>Private context</system-reminder>\nUser follow-up`,
    ),
  ).toBe(`${legacy}\n\nUser follow-up`);
  expect(
    stripNonScheduledSystemReminders(
      `${wrapped}\n<system-reminder>Private context</system-reminder>`,
    ).trim(),
  ).toBe(legacy);
});
