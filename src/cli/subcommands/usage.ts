import { parseArgs } from "node:util";
import { getClient } from "@/backend/api/client";
import {
  getBalanceMetadata,
  getModelQuotaMetadata,
} from "@/backend/api/metadata";
import { isLocalBackendEnabled } from "@/backend/backend";
import { settingsManager } from "@/settings-manager";

export async function runUsageSubcommand(argv: string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(`Usage:
  letta usage

Show a Markdown overview of your plan, credit balance, and letta/* model quota.
The quota bucket is full, high, medium, low, or empty, not an exact request count.
Reset timestamps come from the server; an omitted timestamp is unavailable.
Uses CLI auth and LETTA_API_KEY/LETTA_BASE_URL overrides, not an agent or
conversation selector. User-scoped quota belongs to the authenticated user,
not necessarily the person chatting with an agent. Does not report session tokens.
If either lookup fails, exits nonzero without printing partial usage.
Local mode prints "Running on local backend. Model usage requires BYOK."
without contacting Cloud.

Options:
  -h, --help   Show this help`);
      return 0;
    }
    if (isLocalBackendEnabled()) {
      console.log("Running on local backend. Model usage requires BYOK.");
      return 0;
    }
    await settingsManager.initialize();
    // Reuse CLI OAuth refresh and persist rotated credentials before exiting.
    await getClient();
    await settingsManager.flush();
    const [balance, quota] = await Promise.all([
      getBalanceMetadata(),
      getModelQuotaMetadata(),
    ]);
    const usage = `# Letta usage overview
Current plan: ${balance.billing_tier}

## Usage Credits (non-BYOK models)
* Balance: ${balance.total_balance} credits

## Usage Quota (\`letta/*\` models)
* Bucket (full/high/medium/low/empty): ${quota.lettaTier.bucket}
* Quota Window End: ${quota.quotaWindowEnd}
* Daily Quota Window End: ${quota.dailyQuotaWindowEnd ?? "Unavailable"}
`;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(usage, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 1;
  }
}
