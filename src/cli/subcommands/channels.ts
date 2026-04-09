/**
 * `letta channels` CLI subcommand.
 *
 * Usage:
 *   letta channels configure telegram
 *   letta channels status
 *   letta channels route list
 *   letta channels route add --channel telegram --chat-id <id> --agent <id> --conversation <id>
 *   letta channels route remove --channel telegram --chat-id <id>
 *   letta channels pair --channel telegram --code <code> --agent <id> --conversation <id>
 */

import { parseArgs } from "node:util";
import { readChannelConfig } from "../../channels/config";
import {
  getApprovedUsers,
  getPendingPairings,
  loadPairingStore,
} from "../../channels/pairing";
import { completePairing } from "../../channels/registry";
import {
  addRoute,
  getAllRoutes,
  getRoutesForChannel,
  loadRoutes,
  removeRoute,
} from "../../channels/routing";
import type { ChannelRoute } from "../../channels/types";

// ── Usage ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    `
Usage:
  letta channels configure <channel>          Set up a channel (interactive wizard)
  letta channels status                       Show channel config, routing, pairing state
  letta channels route list [--channel <ch>]  Show routing table
  letta channels route add [options]          Add a route
  letta channels route remove [options]       Remove a route
  letta channels pair [options]               Approve pairing + bind to agent

Route add options:
  --channel <name>       Channel name (e.g. "telegram")
  --chat-id <id>         Chat/conversation ID on the platform
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation ID (defaults to LETTA_CONVERSATION_ID)

Pair options:
  --channel <name>       Channel name (e.g. "telegram")
  --code <code>          Pairing code from the bot
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation ID (defaults to LETTA_CONVERSATION_ID)

Note: "configure" and "status" are standalone-safe. "route add/remove" and
"pair" modify files but do NOT update a running listener — use the /channels
WS command from ADE/desktop for live changes, or restart the server.

Output is JSON.
`.trim(),
  );
}

// ── Args ────────────────────────────────────────────────────────────

const CHANNELS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  channel: { type: "string" },
  "chat-id": { type: "string" },
  agent: { type: "string" },
  conversation: { type: "string" },
  code: { type: "string" },
} as const;

function parseChannelsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: CHANNELS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function getAgentId(fromArgs?: string): string {
  return fromArgs || process.env.LETTA_AGENT_ID || "";
}

function getConversationId(fromArgs?: string): string {
  return fromArgs || process.env.LETTA_CONVERSATION_ID || "default";
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleConfigure(channel: string): Promise<number> {
  if (channel === "telegram") {
    const { runTelegramSetup } = await import("../../channels/telegram/setup");
    const success = await runTelegramSetup();
    return success ? 0 : 1;
  }

  console.error(`Unknown channel: "${channel}". Supported: telegram`);
  return 1;
}

function handleStatus(): number {
  const channels = ["telegram"];
  const result: Record<string, unknown> = {};

  for (const channelId of channels) {
    const config = readChannelConfig(channelId);
    if (!config) {
      result[channelId] = { configured: false };
      continue;
    }

    loadRoutes(channelId);
    loadPairingStore(channelId);
    const routes = getRoutesForChannel(channelId);
    const pending = getPendingPairings(channelId);
    const approved = getApprovedUsers(channelId);

    result[channelId] = {
      configured: true,
      enabled: config.enabled,
      dmPolicy: config.dmPolicy,
      routes: routes.length,
      pendingPairings: pending.length,
      approvedUsers: approved.length,
    };
  }

  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function handleRouteList(
  values: ReturnType<typeof parseChannelsArgs>["values"],
): number {
  const channelId = values.channel;

  if (channelId) {
    loadRoutes(channelId);
    const routes = getRoutesForChannel(channelId);
    console.log(JSON.stringify(routes, null, 2));
  } else {
    // Load all known channels
    for (const ch of ["telegram"]) {
      loadRoutes(ch);
    }
    const routes = getAllRoutes();
    console.log(JSON.stringify(routes, null, 2));
  }

  return 0;
}

function handleRouteAdd(
  values: ReturnType<typeof parseChannelsArgs>["values"],
): number {
  const channelId = values.channel;
  const chatId = values["chat-id"];
  const agentId = getAgentId(values.agent);
  const conversationId = getConversationId(values.conversation);

  if (!channelId) {
    console.error("Error: --channel is required.");
    return 1;
  }
  if (!chatId) {
    console.error("Error: --chat-id is required.");
    return 1;
  }
  if (!agentId) {
    console.error(
      "Error: --agent is required (or set LETTA_AGENT_ID env var).",
    );
    return 1;
  }

  const route: ChannelRoute = {
    chatId,
    agentId,
    conversationId,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  loadRoutes(channelId);
  addRoute(channelId, route);
  console.log(JSON.stringify({ success: true, route }, null, 2));
  console.warn(
    "Note: If a listener is running, restart it or use /channels telegram enable via WS.",
  );
  return 0;
}

function handleRouteRemove(
  values: ReturnType<typeof parseChannelsArgs>["values"],
): number {
  const channelId = values.channel;
  const chatId = values["chat-id"];

  if (!channelId) {
    console.error("Error: --channel is required.");
    return 1;
  }
  if (!chatId) {
    console.error("Error: --chat-id is required.");
    return 1;
  }

  loadRoutes(channelId);
  const removed = removeRoute(channelId, chatId);
  console.log(JSON.stringify({ success: removed }, null, 2));
  if (removed) {
    console.warn(
      "Note: A running listener won't see this change until restarted.",
    );
  }
  return removed ? 0 : 1;
}

async function handlePair(
  values: ReturnType<typeof parseChannelsArgs>["values"],
): Promise<number> {
  const channelId = values.channel;
  const code = values.code;
  const agentId = getAgentId(values.agent);
  const conversationId = getConversationId(values.conversation);

  if (!channelId) {
    console.error("Error: --channel is required.");
    return 1;
  }
  if (!code) {
    console.error("Error: --code is required.");
    return 1;
  }
  if (!agentId) {
    console.error(
      "Error: --agent is required (or set LETTA_AGENT_ID env var).",
    );
    return 1;
  }

  // Load existing state
  loadRoutes(channelId);
  const { loadPairingStore: loadPairing } = await import(
    "../../channels/pairing"
  );
  loadPairing(channelId);

  const result = completePairing(channelId, code, agentId, conversationId);
  console.log(JSON.stringify(result, null, 2));
  if (result.success) {
    console.warn(
      "Note: If a listener is running, restart it or use /channels telegram pair via WS.",
    );
  }
  return result.success ? 0 : 1;
}

// ── Router ──────────────────────────────────────────────────────────

export async function runChannelsSubcommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseChannelsArgs(argv);

  if (values.help) {
    printUsage();
    return 0;
  }

  const [action, ...rest] = positionals;

  switch (action) {
    case "configure": {
      const channel = rest[0];
      if (!channel) {
        console.error("Error: specify a channel to configure (e.g., telegram)");
        return 1;
      }
      return handleConfigure(channel);
    }
    case "status":
      return handleStatus();
    case "route": {
      const routeAction = rest[0];
      switch (routeAction) {
        case "list":
          return handleRouteList(values);
        case "add":
          return handleRouteAdd(values);
        case "remove":
          return handleRouteRemove(values);
        default:
          console.error(
            `Unknown route action: "${routeAction}". Use: list, add, remove`,
          );
          return 1;
      }
    }
    case "pair":
      return await handlePair(values);
    default:
      if (!action) {
        printUsage();
        return 0;
      }
      console.error(
        `Unknown channels action: "${action}". Use: configure, status, route, pair`,
      );
      return 1;
  }
}
