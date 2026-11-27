import { parseArgs } from "node:util";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk/client";
import { render } from "ink";
import { createElement } from "react";
import WebSocket from "ws";
import { getBackend } from "@/backend";
import { startEmbeddedAppServer } from "@/cli/app-server-tui/embedded-app-server";
import {
  createTuiSessionStore,
  type TuiSessionStore,
} from "@/cli/app-server-tui/session-store";
import { TuiRoot } from "@/cli/app-server-tui/TuiRoot";
import { settingsManager } from "@/settings-manager";

type SocketConstructor = NonNullable<
  ConstructorParameters<typeof LettaAgentClient>[0]["WebSocket"]
>;

function printTuiHelp(): void {
  console.log(
    [
      "Usage: letta tui [options]",
      "",
      "Run the interactive terminal UI as a client of an embedded App Server.",
      "",
      "Options:",
      "  --agent <id>          Agent to open (defaults to the last used agent)",
      "  --conversation <id>   Conversation to resume (defaults to a new conversation)",
      "  --new-agent           Create a new agent",
      "  --model <handle>      Model for a newly created agent",
      "  --register            Register this computer with Letta Cloud and share its runtime",
      "  --computer-name <n>   Computer name used with --register",
      "  -h, --help            Show this help",
    ].join("\n"),
  );
}

function runLocalCommand(
  store: TuiSessionStore,
  command: string,
  exit: () => void,
): boolean {
  const name = command.split(/\s+/)[0];
  if (name === "/exit" || name === "/quit") {
    exit();
    return true;
  }
  if (name === "/help") {
    store.note([
      "enter: send (queues while the agent is working)",
      "esc: interrupt the current run",
      "ctrl-c twice: exit",
      "/exit: exit",
    ]);
    return true;
  }
  store.note([`${name} is not available in the App Server TUI yet.`]);
  return true;
}

export async function runTuiSubcommand(argv: string[]): Promise<number> {
  let values: {
    help?: boolean;
    agent?: string;
    conversation?: string;
    "new-agent"?: boolean;
    model?: string;
    register?: boolean;
    "computer-name"?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        agent: { type: "string" },
        conversation: { type: "string" },
        "new-agent": { type: "boolean" },
        model: { type: "string" },
        register: { type: "boolean" },
        "computer-name": { type: "string" },
      },
    }));
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }
  if (values.help) {
    printTuiHelp();
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.error("Error: letta tui requires an interactive terminal.");
    return 1;
  }

  await settingsManager.initialize();
  const backendLabel = getBackend().capabilities.localModelCatalog
    ? "local backend"
    : "Letta Cloud";

  let server: Awaited<ReturnType<typeof startEmbeddedAppServer>>;
  try {
    server = await startEmbeddedAppServer({
      registerWithCloud: values.register === true,
      connectionName: values["computer-name"],
    });
  } catch (error) {
    console.error(
      `Error: unable to start the embedded App Server: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const client = new LettaAgentClient({
    backend: "remote",
    url: server.url,
    WebSocket: WebSocket as unknown as SocketConstructor,
  });

  let store: TuiSessionStore | null = null;
  try {
    const agentId =
      values.agent ??
      (values["new-agent"] ? null : settingsManager.getGlobalLastAgentId()) ??
      (await client.createAgent(values.model ? { model: values.model } : {}));
    const conversationId = values.conversation;
    store = createTuiSessionStore({
      openSession: (canUseTool) =>
        conversationId
          ? client.resumeSession(conversationId, { canUseTool })
          : client.createSession(agentId, { canUseTool }),
    });
    const activeStore = store;
    let exitApp: () => void = () => {};
    const app = render(
      createElement(TuiRoot, {
        store: activeStore,
        header: {
          agentName: agentId,
          backendLabel: server.registered
            ? `${backendLabel} · registered computer`
            : backendLabel,
        },
        onCommand: (command: string) =>
          runLocalCommand(activeStore, command, () => exitApp()),
      }),
      { exitOnCtrlC: false },
    );
    exitApp = () => {
      activeStore.close();
      app.unmount();
    };
    await activeStore.start();
    await app.waitUntilExit();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  } finally {
    store?.close();
    await server.close().catch(() => undefined);
  }
}
