/**
 * `letta channels` CLI subcommand.
 *
 * Usage:
 *   letta channels install telegram
 *   letta channels configure telegram
 *   letta channels status
 *   letta channels route list
 *   letta channels route add --channel telegram --chat-id <id> --agent <id> --conversation <id>
 *   letta channels route remove --channel telegram --chat-id <id>
 *   letta channels pair --channel telegram --code <code> --agent <id> --conversation <id>
 */

import { parseArgs } from "node:util";
import {
  getChannelAccount,
  listChannelAccounts,
} from "../../channels/accounts";
import {
  getApprovedUsers,
  getPendingPairings,
  loadPairingStore,
} from "../../channels/pairing";
import {
  getChannelDisplayName,
  getSupportedChannelIds,
  isSupportedChannelId,
  loadChannelPlugin,
} from "../../channels/pluginRegistry";
import { completePairing } from "../../channels/registry";
import {
  addRoute,
  getAllRoutes,
  getRoutesForChannel,
  loadRoutes,
  removeRoute,
} from "../../channels/routing";
import {
  getChannelRuntimeDir,
  isChannelRuntimeInstalled,
} from "../../channels/runtimeDeps";
import { listChannelAccountSnapshots } from "../../channels/service";
import type { ChannelRoute, SupportedChannelId } from "../../channels/types";

// ── Usage ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    `
Usage:
  letta channels install <channel>            Install channel runtime dependencies
  letta channels configure <channel>          Set up a channel (interactive wizard)
  letta channels status                       Show channel config, routing, pairing state
  letta channels route list [--channel <ch>]  Show routing table
  letta channels route add [options]          Add a route
  letta channels route remove [options]       Remove a route
  letta channels pair [options]               Approve pairing + bind to agent

Route add options:
  --channel <name>       Channel name (e.g. "telegram")
  --account-id <id>      Channel account ID (required when multiple accounts exist)
  --chat-id <id>         Chat/conversation ID on the platform
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation ID (defaults to LETTA_CONVERSATION_ID)

Pair options:
  --channel <name>       Channel name (e.g. "telegram")
  --account-id <id>      Channel account ID (optional; inferred when only one account exists)
  --code <code>          Pairing code from the bot
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation ID (defaults to LETTA_CONVERSATION_ID)

Note: "configure" and "status" are standalone-safe. "route add/remove" and
"pair" modify files but do NOT update a running listener — use the /channels
WS command from ADE/desktop for live changes, or restart the server.

Recommended Telegram flow:
  1. letta channels install telegram          # optional, configure will auto-install too
  2. letta channels configure telegram
  3. letta server --channels telegram
  4. Message the bot from Telegram once to get a pairing code
  5. In the target ADE/desktop conversation, run:
     /channels telegram pair <code>

Headless deploy flow:
  letta server --channels telegram --install-channel-runtimes

State files:
  ~/.letta/channels/telegram/accounts.json
  ~/.letta/channels/telegram/pairing.yaml
  ~/.letta/channels/telegram/routing.yaml

Output is JSON.
`.trim(),
  );
}

// ── Args ────────────────────────────────────────────────────────────

const CHANNELS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  channel: { type: "string" },
  "account-id": { type: "string" },
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

function assertKnownChannelId(channel: string): SupportedChannelId {
  if (!isSupportedChannelId(channel)) {
    const supported = getSupportedChannelIds().join(", ");
    throw new Error(`Unknown channel: "${channel}". Supported: ${supported}`);
  }
  return channel;
}

function resolveSelectedAccountId(
  channelId: SupportedChannelId,
  explicitAccountId?: string,
): string {
  const normalizedAccountId = explicitAccountId?.trim();
  if (normalizedAccountId) {
    const account = getChannelAccount(channelId, normalizedAccountId);
    if (!account) {
      throw new Error(
        `Unknown account "${normalizedAccountId}" for channel "${channelId}".`,
      );
    }
    return normalizedAccountId;
  }

  const accounts = listChannelAccounts(channelId);
  if (accounts.length === 0) {
    throw new Error(
      `Channel "${channelId}" has no configured accounts. Run letta channels configure ${channelId}.`,
    );
  }
  if (accounts.length === 1) {
    const accountId = accounts[0]?.accountId;
    if (!accountId) {
      throw new Error(
        `Channel "${channelId}" account is missing an account ID.`,
      );
    }
    return accountId;
  }

  throw new Error(
    `Channel "${channelId}" has multiple accounts. Pass --account-id.`,
  );
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleInstall(channel: string): Promise<number> {
  let channelId: SupportedChannelId;
  try {
    channelId = assertKnownChannelId(channel);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (isChannelRuntimeInstalled(channelId)) {
    console.log(
      JSON.stringify(
        {
          success: true,
          channel: channelId,
          installed: true,
          runtimeDir: getChannelRuntimeDir(channelId),
          alreadyInstalled: true,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  try {
    const { installChannelRuntime } = await import(
      "../../channels/runtimeDeps"
    );
    await installChannelRuntime(channelId);
    console.log(
      JSON.stringify(
        {
          success: true,
          channel: channelId,
          installed: true,
          runtimeDir: getChannelRuntimeDir(channelId),
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(
      `Failed to install ${getChannelDisplayName(channelId)} runtime: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}

async function handleConfigure(channel: string): Promise<number> {
  let channelId: SupportedChannelId;
  try {
    channelId = assertKnownChannelId(channel);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const plugin = await loadChannelPlugin(channelId);
  if (!plugin.runSetup) {
    console.error(
      `Channel "${channelId}" does not support interactive setup yet.`,
    );
    return 1;
  }

  const success = await plugin.runSetup();
  return success ? 0 : 1;
}

function handleStatus(): number {
  const result: Record<string, unknown> = {};

  for (const channelId of getSupportedChannelIds()) {
    const accounts = listChannelAccountSnapshots(channelId);
    if (accounts.length === 0) {
      result[channelId] = {
        configured: false,
        runtimeInstalled: isChannelRuntimeInstalled(channelId),
      };
      continue;
    }

    loadRoutes(channelId);
    loadPairingStore(channelId);
    const routes = getRoutesForChannel(channelId);
    const pending = getPendingPairings(channelId);
    const approved = getApprovedUsers(channelId);

    result[channelId] = {
      configured: true,
      enabled: accounts.some((account) => account.enabled),
      dmPolicy: accounts[0]?.dmPolicy ?? null,
      runtimeInstalled: isChannelRuntimeInstalled(channelId),
      accounts,
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
    if (!isSupportedChannelId(channelId)) {
      console.error(
        `Unknown channel: "${channelId}". Supported: ${getSupportedChannelIds().join(", ")}`,
      );
      return 1;
    }
    loadRoutes(channelId);
    const routes = getRoutesForChannel(channelId);
    console.log(JSON.stringify(routes, null, 2));
  } else {
    for (const ch of getSupportedChannelIds()) {
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
  const accountId = values["account-id"];
  const chatId = values["chat-id"];
  const agentId = getAgentId(values.agent);
  const conversationId = getConversationId(values.conversation);

  if (!channelId) {
    console.error("Error: --channel is required.");
    return 1;
  }
  if (!isSupportedChannelId(channelId)) {
    console.error(
      `Unknown channel: "${channelId}". Supported: ${getSupportedChannelIds().join(", ")}`,
    );
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

  let resolvedAccountId: string;
  try {
    resolvedAccountId = resolveSelectedAccountId(channelId, accountId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const route: ChannelRoute = {
    accountId: resolvedAccountId,
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
    `Note: If a listener is running, restart it or use /channels ${channelId} enable via WS.`,
  );
  return 0;
}

function handleRouteRemove(
  values: ReturnType<typeof parseChannelsArgs>["values"],
): number {
  const channelId = values.channel;
  const accountId = values["account-id"];
  const chatId = values["chat-id"];

  if (!channelId) {
    console.error("Error: --channel is required.");
    return 1;
  }
  if (!isSupportedChannelId(channelId)) {
    console.error(
      `Unknown channel: "${channelId}". Supported: ${getSupportedChannelIds().join(", ")}`,
    );
    return 1;
  }
  if (!chatId) {
    console.error("Error: --chat-id is required.");
    return 1;
  }

  let resolvedAccountId: string;
  try {
    resolvedAccountId = resolveSelectedAccountId(channelId, accountId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  loadRoutes(channelId);
  const removed = removeRoute(channelId, chatId, resolvedAccountId);
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
  const accountId = values["account-id"];
  const code = values.code;
  const agentId = getAgentId(values.agent);
  const conversationId = getConversationId(values.conversation);

  if (!channelId) {
    console.error("Error: --channel is required.");
    return 1;
  }
  if (!isSupportedChannelId(channelId)) {
    console.error(
      `Unknown channel: "${channelId}". Supported: ${getSupportedChannelIds().join(", ")}`,
    );
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

  const result = completePairing(
    channelId,
    code,
    agentId,
    conversationId,
    accountId,
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.success) {
    console.warn(
      `Note: If a listener is running, restart it or use /channels ${channelId} pair via WS.`,
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
    case "install": {
      const channel = rest[0];
      if (!channel) {
        console.error("Error: specify a channel to install (e.g., telegram)");
        return 1;
      }
      return handleInstall(channel);
    }
    case "configure": {
      const channel = rest[0];
      if (!channel) {
        console.error(
          "Error: specify a channel to configure (e.g., telegram or slack)",
        );
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
        `Unknown channels action: "${action}". Use: install, configure, status, route, pair`,
      );
      return 1;
  }
}
