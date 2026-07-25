import { describe, expect, test } from "bun:test";
import type { CronTask } from "./cron-file";
import { formatCronPrompt } from "./prompt";

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "task-1",
    agent_id: "agent-a",
    conversation_id: "new",
    name: "daily digest",
    description: "summarize the day",
    cron: "0 9 * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "Summarize overnight activity.",
    status: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    last_run_at: null,
    last_run_outcome: null,
    last_run_reason: null,
    last_run_error: null,
    last_missed_at: null,
    missed_count: 0,
    failed_count: 0,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
    ...overrides,
  };
}

const TIMING = {
  intendedOccurrence: new Date("2026-07-24T09:00:00.000Z"),
  schedulerNow: new Date("2026-07-24T09:00:05.000Z"),
};

describe("formatCronPrompt delivery section", () => {
  test("omits delivery lines when the task has no delivery target", () => {
    const prompt = formatCronPrompt(makeTask(), TIMING);
    expect(prompt).not.toContain("Channel delivery");
    expect(prompt).not.toContain("MessageChannel");
  });

  test("includes optional-send instructions with tool args", () => {
    const prompt = formatCronPrompt(
      makeTask({
        delivery: {
          channel: "slack",
          chat_id: "C0123",
          account_id: "acct_1",
          label: "#eng-alerts",
        },
      }),
      TIMING,
    );
    expect(prompt).toContain("Channel delivery (optional)");
    expect(prompt).toContain("#eng-alerts");
    expect(prompt).toContain('"channel":"slack"');
    expect(prompt).toContain('"chat_id":"C0123"');
    expect(prompt).toContain('"accountId":"acct_1"');
    expect(prompt).toContain("do not send anything");
  });

  test("swaps in an unavailability note when the target no longer resolves", () => {
    const prompt = formatCronPrompt(
      makeTask({
        delivery: {
          channel: "telegram",
          chat_id: "111",
          label: "Sarah (DM)",
        },
      }),
      TIMING,
      { deliveryAvailable: false },
    );
    expect(prompt).toContain("no longer available");
    expect(prompt).toContain("Sarah (DM)");
    expect(prompt).not.toContain("Channel delivery (optional)");
  });
});
