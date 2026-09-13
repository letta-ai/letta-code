export function resolveCronAgentId(fromArgs?: string): string {
  return fromArgs || process.env.LETTA_AGENT_ID || "";
}

function resolveConversationAlias(
  fromArgs?: string,
): string | null | undefined {
  if (fromArgs !== "self") return fromArgs;
  const current = process.env.LETTA_CONVERSATION_ID?.trim();
  if (current) return current;
  console.error(
    "Error: --conversation self requires an active conversation (LETTA_CONVERSATION_ID is not set).",
  );
  return null;
}

export function resolveCronAddConversationTarget(
  fromArgs?: string,
): string | null {
  const resolved = resolveConversationAlias(fromArgs);
  return resolved === undefined ? "new" : resolved;
}

export function resolveCronConversationFilter(
  fromArgs?: string,
): string | null | undefined {
  return resolveConversationAlias(fromArgs);
}
