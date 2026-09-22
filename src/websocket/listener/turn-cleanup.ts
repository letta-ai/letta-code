import { runPostTurnMemorySync } from "@/reminders/memory-git-sync";
import { enqueueMemoryGitSyncReminder } from "@/reminders/state";
import { settingsManager } from "@/settings-manager";
import { releaseChannelRuntimeToolsForTurn } from "./channel-runtime-tools";
import { TO_SUBSCRIBERS } from "./connection";
import {
  persistPermissionModeMapForRuntime,
  pruneConversationPermissionModeStateIfDefault,
} from "./permission-mode";
import {
  emitDeviceStatusIfOpen,
  emitProtocolV2Message,
} from "./protocol-outbound";
import { isListenerTransportOpen } from "./transport";
import type { ConversationRuntime } from "./types";

export async function runListenerTurnCleanup(params: {
  runtime: ConversationRuntime;
  agentId?: string | null;
  normalizedAgentId: string | null;
  conversationId: string;
  finalized: boolean;
}): Promise<void> {
  const { runtime, agentId, normalizedAgentId, conversationId, finalized } =
    params;

  if (runtime.transientChannelRuntimeTools) {
    if (agentId) {
      await releaseChannelRuntimeToolsForTurn(runtime.listener, {
        agent_id: agentId,
        conversation_id: conversationId,
      });
    }
    runtime.transientChannelRuntimeTools = false;
  }

  if (!finalized) return;

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
      onMemoryPushed: () => {
        const transport = runtime.listener.transport ?? runtime.listener.socket;
        if (!transport || !isListenerTransportOpen(transport)) return;
        // Direct file edits bypass the memory tool's notification. Wait for
        // the push so readers fetch the new remote contents, not the old ones.
        emitProtocolV2Message(
          transport,
          runtime,
          {
            type: "memory_updated",
            affected_paths: ["*"],
            timestamp: Date.now(),
          },
          { agent_id: agentId, conversation_id: conversationId },
          TO_SUBSCRIBERS,
        );
      },
      enqueueReminder: (text) => {
        enqueueMemoryGitSyncReminder(runtime.reminderState, { text });
      },
    });
  }
}
