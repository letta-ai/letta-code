/**
 * Global agent context for tool execution
 * Stores current agent ID to make it available to tools like Bash
 */

let currentAgentId: string | null = null;

export function setCurrentAgentId(agentId: string) {
  currentAgentId = agentId;
  // Also set in process.env for subprocess inheritance
  process.env.LETTA_SELF_AGENT_ID = agentId;
}

export function getCurrentAgentId(): string | null {
  return currentAgentId;
}

export function clearCurrentAgentId() {
  currentAgentId = null;
  delete process.env.LETTA_SELF_AGENT_ID;
}
