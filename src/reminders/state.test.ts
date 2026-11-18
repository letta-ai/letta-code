import { describe, expect, test } from "bun:test";
import {
  createSharedReminderState,
  resetSharedReminderState,
  syncReminderStateFromContextMessages,
} from "@/reminders/state";

describe("post-compaction context reminders", () => {
  test("missing context metadata preserves the observed boundary", () => {
    const state = createSharedReminderState();
    syncReminderStateFromContextMessages(state, ["system", "original"]);
    state.hasSentAgentInfo = true;
    syncReminderStateFromContextMessages(state, undefined);
    syncReminderStateFromContextMessages(state, null);
    expect(state.hasSentAgentInfo).toBe(true);
    syncReminderStateFromContextMessages(state, ["system", "summary"]);
    expect(state.hasSentAgentInfo).toBe(false);
  });

  test("reset clears the observed boundary and an empty context initializes normally", () => {
    const state = createSharedReminderState();
    syncReminderStateFromContextMessages(state, ["system"]);
    state.hasSentAgentInfo = true;
    syncReminderStateFromContextMessages(state, ["system", "first-user"]);
    expect(state.hasSentAgentInfo).toBe(true);
    resetSharedReminderState(state);
    expect(state.lastContextMessageId).toBeUndefined();
  });
});
