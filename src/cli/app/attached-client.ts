import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import type { terminalSocket } from "@/cli/app/terminal-runtime-events";
import { resolveTerminalCloudCredentials } from "@/websocket/listener/auth";

export async function createAttachedClient(
  address: string,
  WebSocket: ReturnType<typeof terminalSocket>,
  credentials = resolveTerminalCloudCredentials,
  create = (options: ConstructorParameters<typeof LettaAgentClient>[0]) =>
    new LettaAgentClient(options),
) {
  if (address === "cloud") {
    const { apiKey, apiBaseUrl } = await credentials();
    if (!apiKey)
      throw new Error(
        "Sign in with letta /login or set LETTA_API_KEY to use --cloud",
      );
    return create({
      backend: "cloud",
      apiKey,
      apiBaseUrl,
      webSocketAuth: "query",
      WebSocket,
    });
  }
  const url = new URL(address);
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("Expected a ws:// or wss:// app server URL");
  return create({
    backend: "remote",
    url: url.href,
    WebSocket,
    authToken: process.env.LETTA_APP_SERVER_TOKEN,
  });
}
