import { getConversationRuntimeKey } from "./runtime";

export function legacyAuthorityQuarantineEntryIsValid(
  entry: Record<string, unknown>,
  runtimeKey: string,
): boolean {
  const value = entry.legacyAuthorityQuarantine;
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const quarantine = value as Record<string, unknown>;
  const scope = quarantine.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  const typedScope = scope as Record<string, unknown>;
  return (
    (typedScope.agentId === null || typeof typedScope.agentId === "string") &&
    typeof typedScope.conversationId === "string" &&
    getConversationRuntimeKey(
      typedScope.agentId as string | null,
      typedScope.conversationId,
    ) === runtimeKey &&
    typeof quarantine.recoveryLineageId === "string" &&
    typeof quarantine.interruptedRevision === "string" &&
    typeof quarantine.expiresAt === "number" &&
    Number.isFinite(quarantine.expiresAt) &&
    quarantine.expiresAt === entry.expiresAt &&
    entry.preparedTerminal === undefined &&
    entry.queuedInput === undefined &&
    entry.replayCompleted === true
  );
}
