import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { render } from "ink";
import { useEffect } from "react";
import { TerminalApp } from "./TerminalApp";
import { terminalSocket } from "./terminal-runtime-events";
import { TerminalSession } from "./terminal-session";

function AttachedTerminal({ store }: { store: TerminalSession }) {
  useEffect(() => {
    void store.connect();
    return () => store.close();
  }, [store]);
  return <TerminalApp store={store} />;
}

export async function runAttachedTerminal(address: string, target?: string) {
  const url = new URL(address);
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("Expected a ws:// or wss:// app server URL");
  let activeStore: TerminalSession | undefined;
  const client = new LettaAgentClient({
    backend: "remote",
    url: url.href,
    WebSocket: terminalSocket((event) =>
      activeStore?.receiveRuntimeEvent(event),
    ),
    authToken: process.env.LETTA_APP_SERVER_TOKEN,
  });
  try {
    const id = target ?? (await client.agents.list({ limit: 1 }))[0]?.id;
    if (!id) throw new Error("No agents available on this app server");
    const store = new TerminalSession(
      (canUseTool, target) =>
        client.resumeSession(target ?? id, { canUseTool }),
      client,
    );
    activeStore = store;
    const app = render(<AttachedTerminal store={store} />, {
      exitOnCtrlC: false,
    });
    try {
      await app.waitUntilExit();
    } finally {
      store.close();
    }
  } finally {
    await client.close();
  }
}
