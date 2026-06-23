import { afterEach, describe, expect, test } from "bun:test";
import { permissionMode } from "@/permissions/mode";
import {
  type SharedReminderContext,
  sharedReminderProviders,
} from "@/reminders/engine";
import { createSharedReminderState } from "@/reminders/state";

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
    systemInfoReminderEnabled: true,
    skillSources: [],
  };
}

afterEach(() => {
  permissionMode.setMode("standard");
});

describe("shared permission-mode reminder", () => {
  test("emits on first headless turn", async () => {
    permissionMode.setMode("standard");
    const provider = sharedReminderProviders["permission-mode"];
    const reminder = await provider(baseContext("headless-one-shot"));
    expect(reminder).toContain("Permission mode active: standard");
  });

  test("interactive emits on first turn in standard mode (not the default anymore)", async () => {
    permissionMode.setMode("standard");
    const provider = sharedReminderProviders["permission-mode"];
    const context = baseContext("interactive");

    const first = await provider(context);
    expect(first).toContain("Permission mode active: standard");

    permissionMode.setMode("unrestricted");
    const second = await provider(context);
    expect(second).toContain("Permission mode changed to: unrestricted");
  });

  test("interactive does not emit on first turn in unrestricted mode (it is the default)", async () => {
    permissionMode.setMode("unrestricted");
    const provider = sharedReminderProviders["permission-mode"];
    const reminder = await provider(baseContext("interactive"));
    expect(reminder).toBeNull();
  });

  test("interactive emits on first turn in acceptEdits mode", async () => {
    permissionMode.setMode("acceptEdits");
    const provider = sharedReminderProviders["permission-mode"];
    const reminder = await provider(baseContext("interactive"));
    expect(reminder).toContain("Permission mode active: acceptEdits");
  });
});
