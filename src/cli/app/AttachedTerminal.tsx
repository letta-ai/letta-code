import { render } from "ink";
import { useEffect } from "react";
import { createAttachedClient } from "@/cli/app/attached-client";
import { SessionViewHost } from "./SessionViewHost";
import { terminalSocket } from "./terminal-runtime-events";
import { TerminalSession } from "./terminal-session";

function AttachedTerminal({
  store,
  mode,
}: {
  store: TerminalSession;
  mode: "remote" | "cloud";
}) {
  useEffect(() => {
    void store.connect();
    return () => store.close();
  }, [store]);
  return <SessionViewHost store={store} connectionMode={mode} />;
}

export async function runAttachedTerminal(values: {
  cloud?: boolean;
  connect?: string;
  conversation?: string;
  agent?: string;
}) {
  if (values.cloud && values.connect && values.connect !== "cloud")
    throw new Error("Choose either --cloud or --connect <ws-url>");
  const address = values.connect ?? "cloud";
  const target =
    values.conversation === "default"
      ? values.agent
      : (values.conversation ?? values.agent);
  let activeStore: TerminalSession | undefined;
  const client = await createAttachedClient(
    address,
    terminalSocket((event) => activeStore?.receiveRuntimeEvent(event)),
  );
  try {
    const id = target ?? (await client.agents.list({ limit: 1 }))[0]?.id;
    if (!id) throw new Error("No agents available on this app server");
    const store = new TerminalSession(
      (canUseTool, target) =>
        client.resumeSession(target ?? id, { canUseTool }),
      client,
    );
    activeStore = store;
    const app = render(
      <AttachedTerminal
        store={store}
        mode={address === "cloud" ? "cloud" : "remote"}
      />,
      {
        exitOnCtrlC: false,
      },
    );
    try {
      await app.waitUntilExit();
    } finally {
      store.close();
    }
  } finally {
    await client.close();
  }
}
