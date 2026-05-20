import { getCurrentAgentId } from "@/agent/context";
import { settingsManager } from "@/settings-manager";

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
      // No conversation to save -- still track the agent via legacy fields
      settingsManager.updateLocalProjectSettings({ lastAgent: currentAgentId });
      settingsManager.updateSettings({ lastAgent: currentAgentId });
    }
  } catch {
    // Ignore if no agent context set
  }
}
