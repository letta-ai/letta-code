import { afterEach, describe, expect, test } from "bun:test";
import { permissionMode } from "../../permissions/mode";
import {
  sharedReminderProviders,
  type SharedReminderContext,
} from "../../reminders/engine";
import { createSharedReminderState } from "../../reminders/state";

function baseContext(
  mode: SharedReminderContext["mode"],
): SharedReminderContext {
  return {
    mode,
    agent: {
      id: "agent-1",
      name: "Agent 1",
      description: null,
      lastRunAt: null,
    },
    state: createSharedReminderState(),
    sessionContextReminderEnabled: true,
    reflectionSettings: {
      trigger: "off",
      behavior: "reminder",
      stepCount: 25,
    },
    skillSources: [],
    resolvePlanModeReminder: () => "",
  };
}

afterEach(() => {
  permissionMode.setMode("default");
});

describe("shared permission-mode reminder", () => {
  test("emits on first headless turn", async () => {
    permissionMode.setMode("default");
    const provider = sharedReminderProviders["permission-mode"];
    const reminder = await provider(baseContext("headless-one-shot"));
    expect(reminder).toContain("Permission mode active: default");
  });

  test("interactive emits only after mode changes", async () => {
    permissionMode.setMode("default");
    const provider = sharedReminderProviders["permission-mode"];
    const context = baseContext("interactive");

    const first = await provider(context);
    expect(first).toBeNull();

    permissionMode.setMode("bypassPermissions");
    const second = await provider(context);
    expect(second).toContain("Permission mode changed to: bypassPermissions");
  });
});
