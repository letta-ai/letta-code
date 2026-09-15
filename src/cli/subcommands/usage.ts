import { parseArgs } from "node:util";
import { getBalanceMetadata } from "@/backend/api/metadata";
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

Show account credit balance as JSON: total_balance, monthly_credit_balance,
purchased_credit_balance, and billing_tier. Amounts are credits, not dollars.
Uses CLI auth and LETTA_API_KEY/LETTA_BASE_URL overrides, not an agent or
conversation selector. Does not report session tokens or remaining model quota.
Local mode is unsupported; use letta --backend cloud usage for a Cloud account.

Options:
  -h, --help   Show this help`);
      return 0;
    }
    if (isLocalBackendEnabled()) {
      throw new Error(
        "Account credit balance is unavailable in local mode. Use letta --backend cloud usage to query your Cloud account.",
      );
    }
    await settingsManager.initialize();
    const balance = await getBalanceMetadata();
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(balance, null, 2)}\n`, (error) =>
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
