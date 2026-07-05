import { parseArgs } from "node:util";
import {
  type EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";
import { settingsManager } from "@/settings-manager";

type EnvironmentsSubcommandDeps = {
  initializeSettings?: () => Promise<void>;
  listEnvironments?: typeof listEnvironments;
};

function printUsage(): void {
  console.log(
    `
Usage:
  letta environments list [options]

Aliases:
  letta envs list

List options:
  --limit <n>       Max results (default: 50)
  --after <id>      Pagination cursor from a previous environment id
  --online-only     Only include environments with a fresh active connection

Notes:
  - Output is JSON only.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
  - Use --environment <name|device-id|connection-id> with headless messaging
    to route a message through a specific environment.
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

  if (action !== "list") {
    console.error(`Unknown action: ${action}`);
    printUsage();
    return 1;
  }

  await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  const list = deps.listEnvironments ?? listEnvironments;
  const limit = parseLimit(parsed.values.limit, 50);
  const onlineOnly = parsed.values["online-only"] ?? false;
  const result = await list({
    limit,
    after: parsed.values.after,
    onlineOnly,
  });

  const connections = result.connections
    .map((environment) => ({
      ...environment,
      isOnline: isOnline(environment),
    }))
    .filter((environment) => !onlineOnly || environment.isOnline)
    .slice(0, limit);

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
