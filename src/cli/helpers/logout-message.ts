export function buildLogoutSuccessMessage(hasEnvApiKey: boolean): string {
  if (!hasEnvApiKey) {
    return "✓ Logged out successfully. Run 'letta' to re-authenticate.";
  }

  return [
    "✓ Cleared saved Letta credentials.",
    "",
    "Note: LETTA_API_KEY is still set in your shell or system environment.",
    "/logout does not clear environment variables. Remove it manually if you",
    "want to stop authenticating with that key.",
  ].join("\n");
}
