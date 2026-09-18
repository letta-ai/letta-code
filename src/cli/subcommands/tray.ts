import { parseArgs } from "node:util";
import { isLocalAgentId } from "@/agent/agent-id";
import { isLettaCloud } from "@/agent/memory-filesystem";
import {
  createTrayItem,
  deleteTrayItem,
  listTrayItems,
  type TrayPayload,
  updateTrayItem,
} from "@/backend/api/tray";
import { type SessionRef, settingsManager } from "@/settings-manager";

interface TraySubcommandDeps {
  createItem?: typeof createTrayItem;
  deleteItem?: typeof deleteTrayItem;
  getLastSession?: () => SessionRef | null;
  initializeSettings?: () => Promise<void>;
  isCloud?: () => Promise<boolean>;
  listItems?: typeof listTrayItems;
  updateItem?: typeof updateTrayItem;
}

const TRAY_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  conversation: { type: "string" },
  "conversation-id": { type: "string" },
  "tray-payload": { type: "string" },
} as const;

function printUsage(): void {
  console.log(
    `
Usage:
  letta tray add --conversation-id <id> --tray-payload '<json>'
  letta tray list --conversation-id <id>
  letta tray update <tray-item-id> --conversation-id <id> --tray-payload '<json>'
  letta tray delete <tray-item-id> --conversation-id <id>

Options:
  --agent <id>             Agent ID (defaults to active agent context)
  --agent-id <id>          Alias for --agent
  --conversation <id>      Conversation ID
  --conversation-id <id>   Alias for --conversation
  --tray-payload <json>    Versioned Tray payload

Markdownlet V1:
  {"version":1,"type":"markdownlet","title":"Open PRs","markdown":"| PR | Status |\\n|---|---|"}

Notes:
  - Tray is available only for Letta Cloud agents.
  - A conversation can contain at most 15 Tray items.
  - Output is JSON only.
`.trim(),
  );
}

function parseTrayArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: TRAY_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function parseTrayPayload(raw: string | undefined): TrayPayload {
  if (!raw) throw new Error("Pass --tray-payload <json>");

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid --tray-payload JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--tray-payload must be a JSON object");
  }

  const payload = value as Record<string, unknown>;
  const allowedKeys = new Set(["version", "type", "title", "markdown"]);
  const unexpectedKey = Object.keys(payload).find(
    (key) => !allowedKeys.has(key),
  );
  if (unexpectedKey) {
    throw new Error(`Unsupported tray payload field: ${unexpectedKey}`);
  }
  if (payload.version !== 1) {
    throw new Error("Unsupported tray payload version; expected version 1");
  }
  if (payload.type !== "markdownlet") {
    throw new Error('Unsupported tray payload type; expected "markdownlet"');
  }
  if (
    typeof payload.title !== "string" ||
    !payload.title.trim() ||
    payload.title.length > 120
  ) {
    throw new Error("Markdownlet title must be 1-120 characters");
  }
  if (
    typeof payload.markdown !== "string" ||
    payload.markdown.length > 100_000
  ) {
    throw new Error("Markdownlet markdown must be at most 100000 characters");
  }

  return {
    version: 1,
    type: "markdownlet",
    title: payload.title.trim(),
    markdown: payload.markdown,
  };
}

export function resolveTraySession(
  values: {
    agent?: string;
    "agent-id"?: string;
    conversation?: string;
    "conversation-id"?: string;
  },
  env: NodeJS.ProcessEnv,
  fallback: SessionRef | null,
): SessionRef {
  const agentId = (
    values.agent ||
    values["agent-id"] ||
    env.LETTA_AGENT_ID ||
    env.AGENT_ID ||
    fallback?.agentId ||
    ""
  ).trim();
  const conversationId = (
    values.conversation ||
    values["conversation-id"] ||
    env.LETTA_CONVERSATION_ID ||
    env.CONVERSATION_ID ||
    fallback?.conversationId ||
    ""
  ).trim();

  if (!agentId) throw new Error("Pass --agent <id> or run inside an agent");
  if (!conversationId || conversationId === "new") {
    throw new Error("Pass --conversation-id <id>");
  }
  if (isLocalAgentId(agentId)) {
    throw new Error("Tray is only available for Letta Cloud agents");
  }
  return { agentId, conversationId };
}

async function initializeTraySettings(): Promise<void> {
  await settingsManager.initialize();
  await settingsManager.loadLocalProjectSettings();
}

export async function runTraySubcommand(
  argv: string[],
  deps: TraySubcommandDeps = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseTrayArgs>;
  try {
    parsed = parseTrayArgs(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    printUsage();
    return 1;
  }

  const [action, itemId, ...extras] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }
  if (extras.length > 0) {
    console.error("Error: too many positional arguments");
    printUsage();
    return 1;
  }

  try {
    await (deps.initializeSettings ?? initializeTraySettings)();
    if (!(await (deps.isCloud ?? isLettaCloud)())) {
      throw new Error("Tray is only available on Letta Cloud");
    }
    const session = resolveTraySession(
      parsed.values,
      process.env,
      (
        deps.getLastSession ?? (() => settingsManager.getEffectiveLastSession())
      )(),
    );

    if (action === "list") {
      if (itemId) throw new Error("list does not accept a Tray item ID");
      const items = await (deps.listItems ?? listTrayItems)(
        session.agentId,
        session.conversationId,
      );
      console.log(JSON.stringify({ items }, null, 2));
      return 0;
    }

    if (action === "add") {
      if (itemId) throw new Error("add does not accept a Tray item ID");
      const payload = parseTrayPayload(parsed.values["tray-payload"]);
      const item = await (deps.createItem ?? createTrayItem)(
        session.agentId,
        session.conversationId,
        payload,
      );
      console.log(JSON.stringify(item, null, 2));
      return 0;
    }

    if (action === "update") {
      if (!itemId) throw new Error("update requires a Tray item ID");
      const payload = parseTrayPayload(parsed.values["tray-payload"]);
      const item = await (deps.updateItem ?? updateTrayItem)(
        session.agentId,
        session.conversationId,
        itemId,
        payload,
      );
      console.log(JSON.stringify(item, null, 2));
      return 0;
    }

    if (action === "delete" || action === "remove" || action === "rm") {
      if (!itemId) throw new Error(`${action} requires a Tray item ID`);
      if (parsed.values["tray-payload"]) {
        throw new Error(`${action} does not accept --tray-payload`);
      }
      await (deps.deleteItem ?? deleteTrayItem)(
        session.agentId,
        session.conversationId,
        itemId,
      );
      console.log(JSON.stringify({ success: true, id: itemId }, null, 2));
      return 0;
    }

    throw new Error(`Unknown Tray action: ${action}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
