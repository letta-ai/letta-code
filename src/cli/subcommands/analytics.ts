import { parseArgs } from "node:util";
import { startLocalAnalyticsServer } from "@/telemetry/local-analytics/server";
import { DEFAULT_LOCAL_ANALYTICS_PORT } from "@/telemetry/local-analytics/types";

function printUsage(): void {
  console.log(
    `
Usage:
  letta analytics [--port <port>] [--host <host>] [--persist] [--max-events <n>]

Starts a local-only realtime analytics page for local Anthropic provider usage.
Enable emission from local Letta Code instances with:
  LETTA_LOCAL_ANALYTICS=1 letta --backend local

Open the displayed localhost URL to view cache utilization live.
`.trim(),
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${value}"`);
  }
  return parsed;
}

export async function runAnalyticsSubcommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      host: { type: "string" },
      persist: { type: "boolean" },
      "max-events": { type: "string" },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    return 0;
  }

  try {
    const handle = await startLocalAnalyticsServer({
      port: parsePositiveInt(parsed.values.port, DEFAULT_LOCAL_ANALYTICS_PORT),
      host: parsed.values.host ?? "127.0.0.1",
      persist: parsed.values.persist === true,
      maxEvents: parsePositiveInt(parsed.values["max-events"], 10_000),
    });
    console.log(`Letta local analytics listening at ${handle.url}`);
    console.log(
      `Enable clients with LETTA_LOCAL_ANALYTICS_URL=${handle.url} or LETTA_LOCAL_ANALYTICS=1`,
    );
    await new Promise<void>((resolve) => {
      const shutdown = () => resolve();
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    await handle.stop();
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? `Error: ${error.message}` : String(error),
    );
    return 1;
  }
}
