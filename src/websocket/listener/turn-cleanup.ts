import {
  getConversationId,
  getCurrentAgentId,
  setConversationId,
  setCurrentAgentId,
} from "@/agent/context";
import { runPostTurnMemorySync } from "@/reminders/memory-git-sync";
import { enqueueMemoryGitSyncReminder } from "@/reminders/state";
import { settingsManager } from "@/settings-manager";
import {
  persistPermissionModeMapForRuntime,
  pruneConversationPermissionModeStateIfDefault,
} from "./permission-mode";
import { emitDeviceStatusIfOpen } from "./protocol-outbound";
import type { ConversationRuntime } from "./types";

export async function runListenerTurnCleanup(params: {
  runtime: ConversationRuntime;
  agentId?: string | null;
  normalizedAgentId: string | null;
  conversationId: string;
}): Promise<void> {
  const { runtime, agentId, normalizedAgentId, conversationId } = params;

  pruneConversationPermissionModeStateIfDefault(
    runtime.listener,
    normalizedAgentId,
    conversationId,
  );
  persistPermissionModeMapForRuntime(runtime.listener);
  emitDeviceStatusIfOpen(runtime, {
    agent_id: agentId ?? null,
    conversation_id: conversationId,
  });

  if (agentId) {
    await runPostTurnMemorySync({
      agentId,
      isEnabled: (id) => settingsManager.isMemfsEnabled(id),
      debugLabel: "Post-turn listener memory sync",
      enqueueReminder: (text) => {
        enqueueMemoryGitSyncReminder(runtime.reminderState, { text });
      },
    });
  }

  // A replacement turn may begin while post-turn memory sync is awaiting.
  // Its process-global tool context now owns these identifiers.
  if (runtime.turnLifecycle.kind !== "idle") {
    return;
  }

  try {
    const currentConversationId = getConversationId();
    let currentAgentId: string | null = null;
    try {
      currentAgentId = getCurrentAgentId();
    } catch {
      currentAgentId = null;
    }

    if (
      currentAgentId === (agentId ?? null) &&
      currentConversationId === conversationId
    ) {
      setCurrentAgentId(null);
      setConversationId(null);
    }
  } catch {
    // Best-effort cleanup only. Never let teardown obscure the turn result.
  }
}
