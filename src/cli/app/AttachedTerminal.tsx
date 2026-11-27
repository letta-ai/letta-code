import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { render, useApp, useInput } from "ink";
import { useEffect } from "react";
import WebSocket from "ws";
import { TerminalApp } from "./TerminalApp";
import { TerminalSession } from "./terminal-session";

function AttachedTerminal({ store }: { store: TerminalSession }) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
  });
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
  const client = new LettaAgentClient({
    backend: "remote",
    url: url.href,
    WebSocket,
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
