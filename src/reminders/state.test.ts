import { describe, expect, test } from "bun:test";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import {
  createSharedReminderState,
  markPostCompactionContextRemindersPending,
  syncReminderStateFromContextTracker,
} from "@/reminders/state";

describe("post-compaction context reminders", () => {
  test("re-arms one-shot execution context without resetting unrelated state", () => {
    const state = createSharedReminderState();
    state.hasSentAgentInfo = true;
    state.hasSentSessionContext = true;
    state.hasSentSecretsInfo = true;
    state.pendingSecretsInfoRefresh = true;
    state.lastSentSecretNamesKey = "API_KEY";
    state.hasSentConversationBootstrap = true;
    state.pendingConversationBootstrap = true;
    state.lastNotifiedPermissionMode = "standard";
    state.turnCount = 7;
    state.pendingReflectionTrigger = true;
    state.pendingMemoryGitSyncReminders.push({ text: "memory sync" });
    state.pendingCommandIoReminders.push({
      input: "/doctor",
      output: "ok",
      success: true,
    });
    state.pendingToolsetChangeReminders.push({
      source: "test",
      previousToolset: "a",
      newToolset: "b",
      previousTools: ["Read"],
      newTools: ["Read", "Edit"],
    });

    const memoryQueue = state.pendingMemoryGitSyncReminders;
    const commandQueue = state.pendingCommandIoReminders;
    const toolsetQueue = state.pendingToolsetChangeReminders;

    markPostCompactionContextRemindersPending(state);

    expect(state.hasSentAgentInfo).toBe(false);
    expect(state.hasSentSessionContext).toBe(false);
    expect(state.pendingSessionContextReason).toBe("post_compaction");
    expect(state.hasSentSecretsInfo).toBe(false);
    expect(state.pendingSecretsInfoRefresh).toBe(true);
    expect(state.lastSentSecretNamesKey).toBe("API_KEY");
    expect(state.hasSentConversationBootstrap).toBe(true);
    expect(state.pendingConversationBootstrap).toBe(true);
    expect(state.lastNotifiedPermissionMode).toBeNull();
    expect(state.turnCount).toBe(7);
    expect(state.pendingReflectionTrigger).toBe(true);
    expect(state.pendingMemoryGitSyncReminders).toBe(memoryQueue);
    expect(state.pendingCommandIoReminders).toBe(commandQueue);
    expect(state.pendingToolsetChangeReminders).toBe(toolsetQueue);
  });

  test("preserves a more specific pending session-context reason", () => {
    const state = createSharedReminderState();
    state.hasSentSessionContext = true;
    state.pendingSessionContextReason = "cwd_changed";

    markPostCompactionContextRemindersPending(state);

    expect(state.hasSentSessionContext).toBe(false);
    expect(state.pendingSessionContextReason).toBe("cwd_changed");
  });

  test("automatic compaction re-arms context when tracker state is consumed", () => {
    const state = createSharedReminderState();
    state.hasSentAgentInfo = true;
    state.hasSentSessionContext = true;
    state.hasSentSecretsInfo = true;
    const contextTracker = createContextTracker();
    contextTracker.pendingReflectionTrigger = true;

    syncReminderStateFromContextTracker(state, contextTracker);

    expect(state.hasSentAgentInfo).toBe(false);
    expect(state.hasSentSessionContext).toBe(false);
    expect(state.hasSentSecretsInfo).toBe(false);
    expect(state.pendingReflectionTrigger).toBe(true);
    expect(contextTracker.pendingReflectionTrigger).toBe(false);
  });
});
