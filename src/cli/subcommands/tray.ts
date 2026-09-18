import { parseArgs } from "node:util";
import { isLocalAgentId } from "@/agent/agent-id";
import { getBackend } from "@/backend";
import { ApiRequestError } from "@/backend/api/request";
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
  isLocalBackend?: () => boolean;
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
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title || title.length > 120) {
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
    title,
    markdown: payload.markdown,
  };
}

type TrayScopeValues = {
  agent?: string;
  "agent-id"?: string;
  conversation?: string;
  "conversation-id"?: string;
};

function resolveAliasedValue(
  primary: string | undefined,
  alias: string | undefined,
  label: string,
): string | undefined {
  if (
    primary !== undefined &&
    alias !== undefined &&
    primary.trim() !== alias.trim()
  ) {
    throw new Error(`Conflicting ${label} values`);
  }
  return primary ?? alias;
}

function requireCompletePair(
  pair: { agentId?: string; conversationId?: string },
  source: string,
): SessionRef | null {
  const provided =
    pair.agentId !== undefined || pair.conversationId !== undefined;
  if (!provided) return null;
  const agentId = pair.agentId?.trim();
  const conversationId = pair.conversationId?.trim();
  if (!agentId || !conversationId) {
    throw new Error(
      `${source} Tray scope must provide both agent and conversation IDs`,
    );
  }
  return { agentId, conversationId };
}

export function resolveTraySession(
  values: TrayScopeValues,
  env: NodeJS.ProcessEnv,
  fallback: SessionRef | null,
): SessionRef {
  const explicit = requireCompletePair(
    {
      agentId: resolveAliasedValue(values.agent, values["agent-id"], "agent"),
      conversationId: resolveAliasedValue(
        values.conversation,
        values["conversation-id"],
        "conversation",
      ),
    },
    "Explicit",
  );
  if (explicit) return validateTraySession(explicit);

  const lettaEnv = requireCompletePair(
    {
      agentId: env.LETTA_AGENT_ID,
      conversationId: env.LETTA_CONVERSATION_ID,
    },
    "LETTA environment",
  );
  if (lettaEnv) return validateTraySession(lettaEnv);

  const agentEnv = requireCompletePair(
    { agentId: env.AGENT_ID, conversationId: env.CONVERSATION_ID },
    "Agent environment",
  );
  if (agentEnv) return validateTraySession(agentEnv);

  const saved = requireCompletePair(fallback ?? {}, "Saved");
  return validateTraySession(saved);
}

function validateTraySession(session: SessionRef | null): SessionRef {
  if (!session?.agentId) {
    throw new Error("Pass --agent <id> and --conversation-id <id>");
  }
  if (!session.conversationId || session.conversationId === "new") {
    throw new Error("Pass --conversation-id <id>");
  }
  if (isLocalAgentId(session.agentId)) {
    throw new Error("Tray is only available for Letta Cloud agents");
  }
  return session;
}

async function initializeTraySettings(): Promise<void> {
  await settingsManager.initialize();
  await settingsManager.loadLocalProjectSettings();
}

function validateAction(
  action: string,
  itemId: string | undefined,
  trayPayload: string | undefined,
): TrayPayload | undefined {
  if (action === "list") {
    if (itemId) throw new Error("list does not accept a Tray item ID");
    if (trayPayload !== undefined) {
      throw new Error("list does not accept --tray-payload");
    }
    return undefined;
  }
  if (action === "add") {
    if (itemId) throw new Error("add does not accept a Tray item ID");
    return parseTrayPayload(trayPayload);
  }
  if (action === "update") {
    if (!itemId) throw new Error("update requires a Tray item ID");
    return parseTrayPayload(trayPayload);
  }
  if (action === "delete" || action === "remove" || action === "rm") {
    if (!itemId) throw new Error(`${action} requires a Tray item ID`);
    if (trayPayload !== undefined) {
      throw new Error(`${action} does not accept --tray-payload`);
    }
    return undefined;
  }
  throw new Error(`Unknown Tray action: ${action}`);
}

function throwCloudOnlyForMissingRoute(error: unknown): never {
  if (
    error instanceof ApiRequestError &&
    (error.status === 404 || error.status === 405)
  ) {
    throw new Error("Tray is only available on Letta Cloud");
  }
  throw error;
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

  try {
    if (extras.length > 0) throw new Error("too many positional arguments");
    const payload = validateAction(
      action,
      itemId,
      parsed.values["tray-payload"],
    );

    await (deps.initializeSettings ?? initializeTraySettings)();
    if (
      (deps.isLocalBackend ?? (() => getBackend().capabilities.localMemfs))()
    ) {
      throw new Error("Tray is only available on Letta Cloud");
    }
    const session = resolveTraySession(
      parsed.values,
      process.env,
      (
        deps.getLastSession ?? (() => settingsManager.getEffectiveLastSession())
      )(),
    );
    const list = deps.listItems ?? listTrayItems;

    if (action === "list") {
      try {
        const items = await list(session.agentId, session.conversationId);
        console.log(JSON.stringify({ items }, null, 2));
        return 0;
      } catch (error) {
        throwCloudOnlyForMissingRoute(error);
      }
    }

    // Probe the route instead of inferring Cloud support from its URL. Managed
    // Cloud sessions may intentionally reach cloud-api through localhost.
    try {
      await list(session.agentId, session.conversationId);
    } catch (error) {
      throwCloudOnlyForMissingRoute(error);
    }

    if (action === "add" && payload) {
      const item = await (deps.createItem ?? createTrayItem)(
        session.agentId,
        session.conversationId,
        payload,
      );
      console.log(JSON.stringify(item, null, 2));
      return 0;
    }
    if (action === "update" && itemId && payload) {
      const item = await (deps.updateItem ?? updateTrayItem)(
        session.agentId,
        session.conversationId,
        itemId,
        payload,
      );
      console.log(JSON.stringify(item, null, 2));
      return 0;
    }

    if (!itemId) throw new Error("delete requires a Tray item ID");
    await (deps.deleteItem ?? deleteTrayItem)(
      session.agentId,
      session.conversationId,
      itemId,
    );
    console.log(JSON.stringify({ success: true, id: itemId }, null, 2));
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
