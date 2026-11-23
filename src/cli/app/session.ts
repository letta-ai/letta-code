import { isAgentIdCompatibleWithBackend } from "@/agent/agent-id";
import { getCurrentAgentId } from "@/agent/context";
import { settingsManager } from "@/settings-manager";
import { cancelBackgroundMemoryTasks } from "@/tools/impl/memory-task-lifecycle";
import { shutdownMonitors } from "@/tools/impl/monitor";

export function saveLastSessionBeforeExit(conversationId?: string | null) {
  try {
    const currentAgentId = getCurrentAgentId();
    if (conversationId && conversationId !== "default") {
      settingsManager.persistSession(currentAgentId, conversationId);
    } else {
      settingsManager.updateLocalProjectSettings({ lastAgent: currentAgentId });
      if (isAgentIdCompatibleWithBackend(currentAgentId, "api")) {
        settingsManager.updateSettings({ lastAgent: currentAgentId });
      }
    }
  } catch {}
}

export async function prepareSessionExit(
  conversationId?: string | null,
): Promise<void> {
  saveLastSessionBeforeExit(conversationId);
  await cancelBackgroundMemoryTasks();
  await shutdownMonitors();
}
