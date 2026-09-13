import { describe, expect, test } from "bun:test";
import type { CronTask } from "./cron-file";
import {
  formatCronPrompt,
  formatScheduledTaskPrompt,
  parseScheduledTaskPrompt,
} from "./prompt";

const scheduledFor = new Date("2026-07-28T19:56:53.778Z");
const currentTime = new Date("2026-07-28T19:57:12.661Z");

describe("scheduled task prompt envelope", () => {
  test("round-trips the backend-neutral one-off envelope", () => {
    const envelope = formatScheduledTaskPrompt({
      name: "shipping-followup",
      description: "Continue the approved shipping-chain work.",
      timezone: "America/Los_Angeles",
      scheduledFor,
      currentTime,
      recurrence: { type: "one-off" },
      prompt: "Check the workflow run.\nIf it succeeded, review the PR.",
    });

    expect(parseScheduledTaskPrompt(envelope)).toEqual({
      name: "shipping-followup",
      description: "Continue the approved shipping-chain work.",
      timezone: "America/Los_Angeles",
      scheduledFor: "2026-07-28T12:56:53.778-07:00[America/Los_Angeles]",
      recurrence: { type: "one-off" },
      prompt: "Check the workflow run.\nIf it succeeded, review the PR.",
    });
  });

  test("formats recurring envelopes without inventing a fire number", () => {
    const envelope = formatScheduledTaskPrompt({
      name: "daily-status",
      timezone: "UTC",
      scheduledFor,
      currentTime,
      recurrence: { type: "recurring", cron: "0 9 * * *" },
      prompt: "Summarize the incident queue.",
    });

    expect(envelope).toContain(
      "This is a recurring scheduled task (cron: 0 9 * * *).",
    );
    expect(parseScheduledTaskPrompt(envelope)?.recurrence).toEqual({
      type: "recurring",
      cron: "0 9 * * *",
    });
  });

  test("keeps the local scheduler fire number in the shared envelope", () => {
    const task = {
      name: "daily-status",
      description: "Post the morning status.",
      timezone: "UTC",
      recurring: true,
      cron: "0 9 * * *",
      fire_count: 2,
      prompt: "Summarize the incident queue.",
    } as CronTask;

    const envelope = formatCronPrompt(task, {
      intendedOccurrence: scheduledFor,
      schedulerNow: currentTime,
    });

    expect(parseScheduledTaskPrompt(envelope)?.recurrence).toEqual({
      type: "recurring",
      cron: "0 9 * * *",
      fireNumber: 3,
    });
  });

  test("parses the legacy system-reminder envelope", () => {
    const legacy = [
      "<system-reminder>",
      "Scheduled task “Legacy follow-up” is firing.",
      "Description: Check the old run.",
      "This is fire #8 (cron: */15 * * * *).",
      "",
      "Inspect the result and report back.",
      "</system-reminder>",
    ].join("\n");

    expect(parseScheduledTaskPrompt(legacy)).toMatchObject({
      name: "Legacy follow-up",
      recurrence: {
        type: "recurring",
        cron: "*/15 * * * *",
        fireNumber: 8,
      },
      prompt: "Inspect the result and report back.",
    });
  });

  test("does not classify ordinary user text", () => {
    expect(
      parseScheduledTaskPrompt(
        'Can you explain why Scheduled task "Daily status" is firing?',
      ),
    ).toBeNull();
  });
});
