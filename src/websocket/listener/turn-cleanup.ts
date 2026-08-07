import { runPostTurnMemorySync } from "@/reminders/memory-git-sync";
import { enqueueMemoryGitSyncReminder } from "@/reminders/state";
import {
  persistPermissionModeMapForRuntime,
  pruneConversationPermissionModeStateIfDefault,
} from "./permission-mode";
import { emitDeviceStatusIfOpen } from "./protocol-outbound";
import { isConversationMemfsEnabled } from "./runtime-memory";
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
      isEnabled: () => isConversationMemfsEnabled(runtime),
      debugLabel: "Post-turn listener memory sync",
      enqueueReminder: (text) => {
        enqueueMemoryGitSyncReminder(runtime.reminderState, { text });
      },
    });
  }
}
