export function resolvePiRequestHeaders(input: {
  provider: string;
  configuredHeaders: Record<string, string> | undefined;
  conversationId: string;
}): Record<string, string> | undefined {
  if (input.provider !== "opencode-go") return input.configuredHeaders;
  return {
    ...input.configuredHeaders,
    "x-opencode-session": input.conversationId,
  };
}
