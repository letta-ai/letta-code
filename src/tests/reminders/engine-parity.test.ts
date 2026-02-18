import { afterEach, describe, expect, test } from "bun:test";
import type { ReflectionSettings } from "../../cli/helpers/memoryReminder";
import type { SkillSource } from "../../agent/skills";
import { SHARED_REMINDER_IDS } from "../../reminders/catalog";
import {
  buildSharedReminderParts,
  sharedReminderProviders,
} from "../../reminders/engine";
import { createSharedReminderState } from "../../reminders/state";

const originalProviders = { ...sharedReminderProviders };
const providerMap = sharedReminderProviders;

afterEach(() => {
  for (const reminderId of SHARED_REMINDER_IDS) {
    providerMap[reminderId] = originalProviders[reminderId];
  }
});

describe("shared reminder parity", () => {
  test("shared reminder order is identical across interactive and headless modes", async () => {
    for (const reminderId of SHARED_REMINDER_IDS) {
      providerMap[reminderId] = async () => reminderId;
    }

    const reflectionSettings: ReflectionSettings = {
      trigger: "off",
      behavior: "reminder",
      stepCount: 25,
    };

    const base = {
      agent: {
        id: "agent-1",
        name: "Agent 1",
        description: "test",
        lastRunAt: null,
      },
      sessionContextReminderEnabled: true,
      reflectionSettings,
      skillSources: [] as SkillSource[],
      resolvePlanModeReminder: () => "plan",
    };

    const interactive = await buildSharedReminderParts({
      ...base,
      mode: "interactive",
      state: createSharedReminderState(),
    });
    const oneShot = await buildSharedReminderParts({
      ...base,
      mode: "headless-one-shot",
      state: createSharedReminderState(),
    });
    const bidirectional = await buildSharedReminderParts({
      ...base,
      mode: "headless-bidirectional",
      state: createSharedReminderState(),
    });

    expect(interactive.appliedReminderIds).toEqual(SHARED_REMINDER_IDS);
    expect(oneShot.appliedReminderIds).toEqual(SHARED_REMINDER_IDS);
    expect(bidirectional.appliedReminderIds).toEqual(SHARED_REMINDER_IDS);
    expect(interactive.parts.map((part) => part.text)).toEqual(SHARED_REMINDER_IDS);
    expect(oneShot.parts.map((part) => part.text)).toEqual(SHARED_REMINDER_IDS);
    expect(bidirectional.parts.map((part) => part.text)).toEqual(
      SHARED_REMINDER_IDS,
    );
  });
});
