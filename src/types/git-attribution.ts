/** Informational attribution supplied by the client that delivered a turn. */
export interface GitAttribution {
  requester: string;
  conversation: string;
}

export function readGitAttribution(value: unknown): GitAttribution | undefined {
  if (typeof value !== "object" || !value) return;
  const { requester, conversation } = value as Partial<GitAttribution>;
  if (
    typeof requester !== "string" ||
    typeof conversation !== "string" ||
    requester.length > 512 ||
    conversation.length > 2048 ||
    !requester.trim() ||
    !conversation.trim() ||
    /[\r\n\0]/.test(requester + conversation)
  ) {
    return;
  }
  return { requester: requester.trim(), conversation: conversation.trim() };
}
