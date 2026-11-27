/** Only connection credentials and the opaque parent capability enter a relay. */
export const MCP_RELAY_ENV_NAMES = [
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
  "LETTA_API_URL",
  "LETTA_MCP_SUBPROCESS_BROKER_KEY",
  "LETTA_MCP_SUBPROCESS_BROKER_SOCKET",
];

export function getMcpRelayEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    MCP_RELAY_ENV_NAMES.flatMap((name) =>
      env[name] ? [[name, env[name] as string]] : [],
    ),
  );
}
