import { describe, expect, test } from "bun:test";
import {
  enqueueCommandIoReminder,
  enqueueToolsetChangeReminder,
  type SharedReminderState,
} from "../../reminders/state";
import {
  type SharedReminderContext,
  sharedReminderProviders,
} from "../../reminders/engine";
import { createSharedReminderState } from "../../reminders/state";

function baseContext(
  state: SharedReminderState,
  mode: SharedReminderContext["mode"] = "interactive",
): SharedReminderContext {
  return {
    mode,
    agent: {
      id: "agent-1",
      name: "Agent 1",
      description: null,
      lastRunAt: null,
    },
    state,
    sessionContextReminderEnabled: false,
    reflectionSettings: {
      trigger: "off",
      behavior: "reminder",
      stepCount: 25,
    },
    skillSources: [],
    resolvePlanModeReminder: () => "",
  };
}

describe("interaction reminders", () => {
  test("command-io provider renders escaped command input/output and drains queue", async () => {
    const state = createSharedReminderState();
    enqueueCommandIoReminder(state, {
      input: '/model && echo "<unsafe>"',
      output: "Models dialog dismissed <ok>",
      success: true,
    });

    const reminder = await sharedReminderProviders["command-io"](
      baseContext(state),
    );
    expect(reminder).toContain("<user-command-input>");
    expect(reminder).toContain("&lt;unsafe&gt;");
    expect(reminder).toContain("<user-command-output>");
    expect(reminder).toContain("&lt;ok&gt;");
    expect(state.pendingCommandIoReminders).toHaveLength(0);
  });

  test("toolset-change provider renders previous/new toolset and drains queue", async () => {
    const state = createSharedReminderState();
    enqueueToolsetChangeReminder(state, {
      source: "/toolset",
      previousToolset: "default",
      newToolset: "codex",
      previousTools: ["Read", "Write"],
      newTools: ["ReadFile", "ApplyPatch", "ShellCommand"],
    });

    const reminder = await sharedReminderProviders["toolset-change"](
      baseContext(state),
    );
    expect(reminder).toContain("<source>/toolset</source>");
    expect(reminder).toContain("<previous-toolset>default</previous-toolset>");
    expect(reminder).toContain("<new-toolset>codex</new-toolset>");
    expect(reminder).toContain("<previous-tools>Read, Write</previous-tools>");
    expect(reminder).toContain(
      "<new-tools>ReadFile, ApplyPatch, ShellCommand</new-tools>",
    );
    expect(state.pendingToolsetChangeReminders).toHaveLength(0);
  });

  test("interaction reminder providers return null when there is no queued data", async () => {
    const state = createSharedReminderState();
    const commandReminder = await sharedReminderProviders["command-io"](
      baseContext(state),
    );
    const toolsetReminder = await sharedReminderProviders["toolset-change"](
      baseContext(state),
    );
    expect(commandReminder).toBeNull();
    expect(toolsetReminder).toBeNull();
  });
});
