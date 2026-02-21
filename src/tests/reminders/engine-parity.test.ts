import { afterEach, describe, expect, test } from "bun:test";
import type { SkillSource } from "../../agent/skills";
import type { ReflectionSettings } from "../../cli/helpers/memoryReminder";
import {
  SHARED_REMINDER_CATALOG,
  SHARED_REMINDER_IDS,
  type SharedReminderId,
  type SharedReminderMode,
} from "../../reminders/catalog";
import {
  buildSharedReminderParts,
  sharedReminderProviders,
} from "../../reminders/engine";
import { createSharedReminderState } from "../../reminders/state";

const originalProviders = { ...sharedReminderProviders };
const providerMap = sharedReminderProviders;

function reminderIdsForMode(mode: SharedReminderMode): SharedReminderId[] {
  return SHARED_REMINDER_CATALOG.filter((entry) =>
    entry.modes.includes(mode),
  ).map((entry) => entry.id);
}

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

    expect(interactive.appliedReminderIds).toEqual(
      reminderIdsForMode("interactive"),
    );
    expect(oneShot.appliedReminderIds).toEqual(
      reminderIdsForMode("headless-one-shot"),
    );
    expect(bidirectional.appliedReminderIds).toEqual(
      reminderIdsForMode("headless-bidirectional"),
    );
    expect(interactive.parts.map((part) => part.text)).toEqual(
      reminderIdsForMode("interactive"),
    );
    expect(oneShot.parts.map((part) => part.text)).toEqual(
      reminderIdsForMode("headless-one-shot"),
    );
    expect(bidirectional.parts.map((part) => part.text)).toEqual(
      reminderIdsForMode("headless-bidirectional"),
    );
  });

  test("subagent mode produces only agent-metadata reminder", async () => {
    for (const reminderId of SHARED_REMINDER_IDS) {
      providerMap[reminderId] = async () => reminderId;
    }

    const reflectionSettings: ReflectionSettings = {
      trigger: "off",
      behavior: "reminder",
      stepCount: 25,
    };

    const subagent = await buildSharedReminderParts({
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
      mode: "subagent",
      state: createSharedReminderState(),
    });

    expect(subagent.appliedReminderIds).toEqual(reminderIdsForMode("subagent"));
    expect(subagent.appliedReminderIds).toEqual(["agent-metadata"]);
    expect(subagent.parts.map((part) => part.text)).toEqual(["agent-metadata"]);
  });
});
