import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import { createSharedReminderState } from "@/reminders/state";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import {
  createConversationRuntime,
  evictConversationRuntimeIfIdle,
} from "@/websocket/listener/runtime";

describe("listen reflection runtime state", () => {
  test("preserves reminder state and context tracker across conversation runtime eviction", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeKey = "agent:agent-1::conversation:conv-1";
    const persistedReminderState = createSharedReminderState();
    persistedReminderState.turnCount = 7;
    persistedReminderState.pendingReflectionTrigger = true;
    const persistedContextTracker = createContextTracker();
    persistedContextTracker.currentTurnId = 9;
    persistedContextTracker.pendingReflectionTrigger = true;

    listener.reminderStateByConversation.set(
      runtimeKey,
      persistedReminderState,
    );
    listener.contextTrackerByConversation.set(
      runtimeKey,
      persistedContextTracker,
    );

    const runtime = createConversationRuntime(listener, "agent-1", "conv-1");
    expect(runtime.reminderState).toBe(persistedReminderState);
    expect(runtime.contextTracker).toBe(persistedContextTracker);

    runtime.pendingTurns = 0;
    runtime.queuePumpActive = false;
    runtime.queuePumpScheduled = false;
    runtime.recoveredApprovalState = null;
    runtime.pendingInterruptedResults = null;
    runtime.pendingInterruptedContext = null;
    runtime.pendingInterruptedToolCallIds = null;
    runtime.queuedMessagesByItemId.clear();

    expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);
    expect(listener.conversationRuntimes.has(runtime.key)).toBe(false);

    const recreated = createConversationRuntime(listener, "agent-1", "conv-1");
    expect(recreated.reminderState).toBe(persistedReminderState);
    expect(recreated.contextTracker).toBe(persistedContextTracker);
    expect(recreated.reminderState.turnCount).toBe(7);
    expect(recreated.contextTracker.currentTurnId).toBe(9);
    expect(recreated.contextTracker.pendingReflectionTrigger).toBe(true);
  });

  test("listener reflection delegates MemFS root resolution to launcher", () => {
    const turnPath = fileURLToPath(
      new URL("./listener/turn.ts", import.meta.url),
    );
    const source = readFileSync(turnPath, "utf-8");

    expect(source).not.toContain("memoryDir: getMemoryFilesystemRoot");
    expect(source).not.toContain("memoryDir: getScopedMemoryFilesystemRoot");
  });

  test("listener lifecycle reflection uses the shared launcher", () => {
    const lifecyclePath = fileURLToPath(
      new URL("./listener/lifecycle.ts", import.meta.url),
    );
    const source = readFileSync(lifecyclePath, "utf-8");

    expect(source).toContain("launchReflectionSubagent({");
    expect(source).not.toContain("buildReflectionSubagentPrompt({");
    expect(source).not.toContain("memoryDir: getMemoryFilesystemRoot");
    expect(source).not.toContain("memoryDir: getScopedMemoryFilesystemRoot");
  });
});
