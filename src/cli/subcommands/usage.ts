import { parseArgs } from "node:util";
import { getClient } from "@/backend/api/client";
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

Show a Markdown overview of your plan and remaining credit balance.
Local backend: model usage requires BYOK.

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
    const balance = await getBalanceMetadata();
    const usage = `# Letta usage overview
Current plan: ${balance.billing_tier}

## Usage Credits (non-BYOK models)
* Balance: ${balance.total_balance} credits
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
