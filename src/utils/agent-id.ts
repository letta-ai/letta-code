/**
 * Utilities for identifying agent IDs by backend type.
 * Kept in utils/ so both backend/ and cli/ layers can import it.
 */

const LOCAL_AGENT_ID_PREFIX = "agent-local-";

export function isLocalAgentId(agentId: string): boolean {
  return agentId.startsWith(LOCAL_AGENT_ID_PREFIX);
}
