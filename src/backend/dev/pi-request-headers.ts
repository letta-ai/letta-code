export function resolvePiRequestHeaders(input: {
  provider: string;
  configuredHeaders: Record<string, string> | undefined;
  conversationId: string;
  requestKind: "turn" | "compaction";
}): Record<string, string> {
  return {
    ...input.configuredHeaders,
    "x-letta-request-kind": input.requestKind,
    ...(input.provider === "opencode-go"
      ? { "x-opencode-session": input.conversationId }
      : {}),
  };
}
