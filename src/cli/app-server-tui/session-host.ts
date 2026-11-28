import { LettaAgentClient } from "@letta-ai/letta-agent-sdk/client";
import WebSocket from "ws";
import {
  type EmbeddedAppServer,
  startEmbeddedAppServer,
} from "./embedded-app-server";
import { createTuiSessionStore, type TuiSessionStore } from "./session-store";

type SocketConstructor = NonNullable<
  ConstructorParameters<typeof LettaAgentClient>[0]["WebSocket"]
>;

export interface SessionHostOptions {
  connectUrl?: string;
  registerWithCloud?: boolean;
  computerName?: string;
}

export interface SessionHost {
  url: string;
  mode: "embedded" | "registered" | "attached";
  open: (agentId: string, conversationId: string) => TuiSessionStore;
  close: () => Promise<void>;
}

export function readSessionHostOptions(argv: string[]): SessionHostOptions {
  const options: SessionHostOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--register") options.registerWithCloud = true;
    else if (arg === "--connect") options.connectUrl = argv[index + 1];
    else if (arg?.startsWith("--connect="))
      options.connectUrl = arg.slice("--connect=".length);
    else if (arg === "--computer-name") options.computerName = argv[index + 1];
  }
  return options;
}

export async function startSessionHost(
  options: SessionHostOptions = {},
): Promise<SessionHost> {
  let embedded: EmbeddedAppServer | null = null;
  let url = options.connectUrl;
  if (!url) {
    embedded = await startEmbeddedAppServer({
      registerWithCloud: options.registerWithCloud === true,
      connectionName: options.computerName,
    });
    url = embedded.url;
  }
  const client = new LettaAgentClient({
    backend: "remote",
    url,
    WebSocket: WebSocket as unknown as SocketConstructor,
  });
  return {
    url,
    mode: embedded
      ? embedded.registered
        ? "registered"
        : "embedded"
      : "attached",
    open: (agentId, conversationId) =>
      createTuiSessionStore({
        defaultConversation: conversationId === "default",
        openSession: (canUseTool) =>
          conversationId === "default"
            ? client.resumeSession(agentId, { canUseTool })
            : client.resumeSession(conversationId, { canUseTool }),
      }),
    close: async () => {
      await embedded?.close().catch(() => undefined);
    },
  };
}
