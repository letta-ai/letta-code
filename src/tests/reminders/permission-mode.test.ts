import { afterEach, describe, expect, test } from "bun:test";
import { permissionMode } from "../../permissions/mode";
import {
  type SharedReminderContext,
  sharedReminderProviders,
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

  test("interactive does not emit on first turn in default mode", async () => {
    permissionMode.setMode("default");
    const provider = sharedReminderProviders["permission-mode"];
    const context = baseContext("interactive");

    const first = await provider(context);
    expect(first).toBeNull();

    permissionMode.setMode("bypassPermissions");
    const second = await provider(context);
    expect(second).toContain("Permission mode changed to: bypassPermissions");
  });

  test("interactive emits on first turn in bypassPermissions mode", async () => {
    permissionMode.setMode("bypassPermissions");
    const provider = sharedReminderProviders["permission-mode"];
    const reminder = await provider(baseContext("interactive"));
    expect(reminder).toContain("Permission mode active: bypassPermissions");
  });

  test("interactive emits on first turn in acceptEdits mode", async () => {
    permissionMode.setMode("acceptEdits");
    const provider = sharedReminderProviders["permission-mode"];
    const reminder = await provider(baseContext("interactive"));
    expect(reminder).toContain("Permission mode active: acceptEdits");
  });
});
