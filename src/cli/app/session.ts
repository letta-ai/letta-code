import { isAgentIdCompatibleWithBackend } from "@/agent/agent-id";
import { getCurrentAgentId } from "@/agent/context";
import { settingsManager } from "@/settings-manager";
import { cancelBackgroundMemoryTasks } from "@/tools/impl/memory-task-lifecycle";

// Save current agent + conversation as last session before exiting.
// This ensures subagent overwrites during the session don't persist,
// and the conversation ID is always up-to-date on exit.
export function saveLastSessionBeforeExit(conversationId?: string | null) {
  try {
    const currentAgentId = getCurrentAgentId();
    if (conversationId && conversationId !== "default") {
      // persistSession writes session + legacy lastAgent fields
      settingsManager.persistSession(currentAgentId, conversationId);
    } else {
      // No conversation to save — keep project-local lastAgent updated.
      // Only mirror into global legacy state for cloud/self-hosted agents.
      settingsManager.updateLocalProjectSettings({ lastAgent: currentAgentId });
      if (isAgentIdCompatibleWithBackend(currentAgentId, "api")) {
        settingsManager.updateSettings({ lastAgent: currentAgentId });
      }
    }
  } catch {
    // Ignore if no agent context set
  }
}

/**
 * Everything a controlled interactive exit must do before the process goes:
 * persist the session, then tear down memory workers, which must not outlive
 * the session that owns their checkout. Their in-flight work is dropped.
 */
export async function prepareSessionExit(
  conversationId?: string | null,
): Promise<void> {
  saveLastSessionBeforeExit(conversationId);
  await cancelBackgroundMemoryTasks();
}
