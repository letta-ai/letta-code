import { parseArgs } from "node:util";
import { getRuntimeEnvironmentDeviceId } from "@/backend/api/client";
import {
  type EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import { isVersionBelow } from "@/utils/version";
import { getVersion } from "@/version.ts";
import {
  type ComputersUpgradeDeps,
  runComputersUpgrade,
  UPGRADE_COMMAND_ID,
} from "./computers-upgrade";

type EnvironmentsSubcommandDeps = {
  initializeSettings?: () => Promise<void>;
  listEnvironments?: typeof listEnvironments;
  upgrade?: Omit<ComputersUpgradeDeps, "listEnvironments">;
  /** Latest published letta-code version; rejects when the check fails. */
  fetchLatestVersion?: () => Promise<string>;
};

const LATEST_VERSION_TIMEOUT_MS = 5000;

async function defaultFetchLatestVersion(): Promise<string> {
  const { fetchLatestPublishedVersion } = await import("@/updater/auto-update");
  return fetchLatestPublishedVersion(fetch, LATEST_VERSION_TIMEOUT_MS);
}

/** Resolve the latest version, or null when the check fails or times out. */
async function resolveLatestVersion(
  fetchLatestVersion: () => Promise<string>,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchLatestVersion(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LATEST_VERSION_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Online computers that can be upgraded remotely and run an older version. */
function isUpgradeable(
  environment: EnvironmentWithOnlineStatus,
  latestVersion: string | null,
): boolean {
  const version = environment.metadata?.lettaCodeVersion;
  const supported = environment.metadata?.supported_commands;
  return (
    latestVersion !== null &&
    environment.isOnline &&
    typeof version === "string" &&
    Array.isArray(supported) &&
    supported.includes(UPGRADE_COMMAND_ID) &&
    isVersionBelow(version, latestVersion)
  );
}

type EnvironmentWithOnlineStatus = EnvironmentConnection & {
  isOnline: boolean;
};

function printUsage(): void {
  console.log(
    `
Usage:
  letta computers list [options]
  letta computers current
  letta computers upgrade <computer> [options]

Legacy aliases:
  letta environments list
  letta environments current
  letta envs list
  letta envs current

List options:
  --limit <n>       Max results (default: 50)
  --after <id>      The id of the last record from the previous page
  --online-only     Only include computers with a fresh active connection
  --json            Print only JSON (no upgrade hints on stderr)

Upgrade options:
  --agent <id>          Agent scope for the request (defaults to LETTA_AGENT_ID,
                        then the last agent used on this machine)
  --conversation <id>   Conversation scope (defaults to LETTA_CONVERSATION_ID,
                        then "default")
  --json                Print the result as JSON

Notes:
  - list/current print JSON on stdout. list marks online computers running
    an older letta-code with "outdated": true and "latestVersion", and
    prints an upgrade hint for each on stderr unless --json is set.
  - upgrade tells an online computer's listener to update letta-code in
    place and restart. <computer> is a name, deviceId, id, or connectionId.
  - Pass nextCursor to --after to advance, including with --online-only.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
  - Use letta computers current to get this computer's stable deviceId.
  - Prefer deviceId or connectionName for --computer and Agent(computer=...).
    connectionId is ephemeral; use it only to pin a specific listener.
  - Use --computer cloud to route through the target agent's cloud sandbox.
  - Use --computer <name|device-id|connection-id> with headless messaging
    to route a message through a specific registered computer.
`.trim(),
  );
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function isOnline(environment: EnvironmentConnection): boolean {
  return (
    typeof environment.connectionId === "string" &&
    environment.connectionId.length > 0 &&
    typeof environment.lastHeartbeat === "number" &&
    Date.now() - environment.lastHeartbeat < 120_000
  );
}

function formatEnvironmentForCli(
  environment: EnvironmentWithOnlineStatus,
  options: { onlineOnly: boolean; currentConnectionId?: string | null },
) {
  const formatted = {
    id: environment.id,
    deviceId: environment.deviceId,
    connectionName: environment.connectionName,
    connectionId: environment.connectionId ?? null,
    lettaCodeVersion: environment.metadata?.lettaCodeVersion ?? null,
    ...(environment.connectionId &&
    environment.connectionId === options.currentConnectionId
      ? { isCurrent: true }
      : {}),
  };
  if (options.onlineOnly) {
    return formatted;
  }
  return {
    ...formatted,
    isOnline: environment.isOnline,
  };
}

function findCurrentEnvironment(
  environments: EnvironmentConnection[],
  options: { deviceId: string; savedName?: string; currentVersion: string },
): EnvironmentWithOnlineStatus | null {
  return (
    environments
      .map((environment) => ({
        ...environment,
        isOnline: isOnline(environment),
      }))
      .filter(
        (environment) =>
          environment.deviceId === options.deviceId &&
          environment.isOnline &&
          environment.connectionId,
      )
      .sort(
        (a, b) =>
          scoreCurrentEnvironment(b, options) -
          scoreCurrentEnvironment(a, options),
      )[0] ?? null
  );
}

function scoreCurrentEnvironment(
  environment: EnvironmentWithOnlineStatus,
  options: { savedName?: string; currentVersion: string },
): number {
  let score = 0;
  if (environment.connectionName === options.savedName) score += 100;
  if (environment.metadata?.lettaCodeVersion === options.currentVersion) {
    score += 50;
  }
  if (environment.connectionId?.startsWith("local-")) score += 10;
  score += environment.lastHeartbeat ?? environment.lastSeenAt ?? 0;
  return score;
}

const ENVIRONMENTS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  limit: { type: "string" },
  after: { type: "string" },
  "online-only": { type: "boolean" },
  agent: { type: "string" },
  conversation: { type: "string" },
  json: { type: "boolean" },
} as const;

function parseEnvironmentsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: ENVIRONMENTS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function runUpgradeAction(
  parsed: ReturnType<typeof parseEnvironmentsArgs>,
  list: typeof listEnvironments,
  deps: EnvironmentsSubcommandDeps["upgrade"] = {},
): Promise<number> | number {
  const selector = parsed.positionals[1];
  if (!selector) {
    console.error("Error: letta computers upgrade requires a <computer>.");
    printUsage();
    return 1;
  }
  const agentId =
    parsed.values.agent ||
    process.env.LETTA_AGENT_ID ||
    settingsManager.getGlobalLastAgentId();
  if (!agentId) {
    console.error(
      "Error: --agent is required (or set LETTA_AGENT_ID); the listener scopes remote commands to an agent.",
    );
    return 1;
  }
  return runComputersUpgrade(
    {
      selector,
      scope: {
        agent_id: agentId,
        conversation_id:
          parsed.values.conversation ||
          process.env.LETTA_CONVERSATION_ID ||
          "default",
      },
      json: parsed.values.json ?? false,
    },
    { ...deps, listEnvironments: list },
  );
}

export async function runEnvironmentsSubcommand(
  argv: string[],
  deps: EnvironmentsSubcommandDeps = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseEnvironmentsArgs>;
  try {
    parsed = parseEnvironmentsArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  if (action !== "list" && action !== "current" && action !== "upgrade") {
    console.error(`Unknown action: ${action}`);
    printUsage();
    return 1;
  }

  await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  const list = deps.listEnvironments ?? listEnvironments;
  if (action === "upgrade") {
    return runUpgradeAction(parsed, list, deps.upgrade);
  }
  const deviceId = getRuntimeEnvironmentDeviceId();
  const savedName = settingsManager.getListenerEnvName();
  const currentVersion = getVersion();
  if (action === "current") {
    const result = await list({ limit: 100, onlineOnly: true });
    const current = findCurrentEnvironment(result.connections, {
      deviceId,
      savedName,
      currentVersion,
    });
    if (!current) {
      console.error(
        "No online computer found for this device. Start one with `letta server` and try again.",
      );
      return 1;
    }

    console.log(
      JSON.stringify(
        formatEnvironmentForCli(current, {
          onlineOnly: true,
          currentConnectionId: current.connectionId,
        }),
        null,
        2,
      ),
    );
    return 0;
  }

  const limit = parseLimit(parsed.values.limit, 50);
  const onlineOnly = parsed.values["online-only"] ?? false;
  const [result, latestVersion] = await Promise.all([
    list({
      limit,
      after: parsed.values.after,
      onlineOnly,
    }),
    resolveLatestVersion(deps.fetchLatestVersion ?? defaultFetchLatestVersion),
  ]);
  const current = findCurrentEnvironment(result.connections, {
    deviceId,
    savedName,
    currentVersion,
  });
  const currentConnectionId = current?.connectionId ?? null;

  const visible = result.connections
    .map((environment) => ({
      ...environment,
      isOnline: isOnline(environment),
    }))
    .filter((environment) => !onlineOnly || environment.isOnline)
    .slice(0, limit);
  const outdated = visible.filter((environment) =>
    isUpgradeable(environment, latestVersion),
  );
  const connections = visible.map((environment) => ({
    ...formatEnvironmentForCli(environment, {
      onlineOnly,
      currentConnectionId,
    }),
    ...(latestVersion && outdated.includes(environment)
      ? { outdated: true, latestVersion }
      : {}),
  }));

  console.log(
    JSON.stringify(
      {
        ...result,
        nextCursor: result.hasNextPage
          ? (result.connections.at(-1)?.id ?? null)
          : null,
        connections,
      },
      null,
      2,
    ),
  );
  if (!parsed.values.json) {
    for (const environment of outdated) {
      console.error(
        `Update available for ${environment.connectionName} (${environment.metadata?.lettaCodeVersion} → ${latestVersion}): letta computers upgrade ${environment.deviceId}`,
      );
    }
  }
  return 0;
}
