/** Memory access refusals last for this process, never in persisted settings. */
const unavailableAgents = new Set<string>();

export function isMemoryUnavailable(agentId: string): boolean {
  return unavailableAgents.has(agentId);
}

export function markMemoryUnavailable(agentId: string): void {
  unavailableAgents.add(agentId);
}

export function isMemoryAccessRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:returned error:|HTTP(?: status)?)[ :]*(?:401|403)\b|authentication failed|permission denied \(publickey\)/i.test(
    message,
  );
}
