import { parseArgs } from "node:util";
import {
  type EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";
import { getVersion } from "@/version.ts";

type EnvironmentsSubcommandDeps = {
  initializeSettings?: () => Promise<void>;
  listEnvironments?: typeof listEnvironments;
};

type EnvironmentWithOnlineStatus = EnvironmentConnection & {
  isOnline: boolean;
};

function printUsage(): void {
  console.log(
    `
Usage:
  letta environments list [options]
  letta environments current

Aliases:
  letta envs list
  letta envs current

List options:
  --limit <n>       Max results (default: 50)
  --after <id>      Pagination cursor from a previous environment id
  --online-only     Only include environments with a fresh active connection

Notes:
  - Output is JSON only.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
  - Use letta environments current to get this machine's connectionId.
  - Use --environment cloud to route through the target agent's cloud sandbox.
  - Use --environment <name|device-id|connection-id> with headless messaging
    to route a message through a specific registered environment.
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
} as const;

function parseEnvironmentsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: ENVIRONMENTS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
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

  if (action !== "list" && action !== "current") {
    console.error(`Unknown action: ${action}`);
    printUsage();
    return 1;
  }

  await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  const list = deps.listEnvironments ?? listEnvironments;
  const deviceId = settingsManager.getOrCreateDeviceId();
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
        "No online environment found for this device. Start one with `letta server` and try again.",
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
  const result = await list({
    limit,
    after: parsed.values.after,
    onlineOnly,
  });
  const current = findCurrentEnvironment(result.connections, {
    deviceId,
    savedName,
    currentVersion,
  });
  const currentConnectionId = current?.connectionId ?? null;

  const connections = result.connections
    .map((environment) => ({
      ...environment,
      isOnline: isOnline(environment),
    }))
    .filter((environment) => !onlineOnly || environment.isOnline)
    .slice(0, limit)
    .map((environment) =>
      formatEnvironmentForCli(environment, { onlineOnly, currentConnectionId }),
    );

  console.log(
    JSON.stringify(
      {
        ...result,
        connections,
      },
      null,
      2,
    ),
  );
  return 0;
}
