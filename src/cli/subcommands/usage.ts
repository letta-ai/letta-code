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

Show account credits and model quota as JSON. Credit fields: total_balance,
monthly_credit_balance, purchased_credit_balance, billing_tier, credit_scope.
Amounts are credits, not dollars; credit_scope is organization.
model_quota contains per-tier bucket/dailyBucket statuses (full, high, medium,
low, empty), quotaWindowEnd/dailyQuotaWindowEnd reset times, scope, and seatTier
when provided. Quota scope is user, organization, or unknown if not provided.
These are server-reported buckets, not exact request counts or percentages.
Uses CLI auth and LETTA_API_KEY/LETTA_BASE_URL overrides, not an agent or
conversation selector. User-scoped quota belongs to the authenticated user,
not necessarily the person chatting with an agent. Does not report session tokens.
If either lookup fails, exits nonzero without printing partial usage.
Local mode is unsupported; use letta --backend cloud usage for a Cloud account.

Options:
  -h, --help   Show this help`);
      return 0;
    }
    if (isLocalBackendEnabled()) {
      throw new Error(
        "Account usage is unavailable in local mode. Use letta --backend cloud usage to query your Cloud account.",
      );
    }
    await settingsManager.initialize();
    // Reuse CLI OAuth refresh and persist rotated credentials before exiting.
    await getClient();
    await settingsManager.flush();
    const [balance, quota] = await Promise.all([
      getBalanceMetadata(),
      getModelQuotaMetadata(),
    ]);
    const usage = {
      ...balance,
      credit_scope: "organization",
      model_quota: {
        scope:
          quota.isUserScoped === true
            ? "user"
            : quota.isUserScoped === false
              ? "organization"
              : "unknown",
        seatTier: quota.seatTier,
        basic: quota.basic,
        standard: quota.standard,
        lettaTier: quota.lettaTier,
        premium: quota.premium,
        quotaWindowEnd: quota.quotaWindowEnd,
        dailyQuotaWindowEnd: quota.dailyQuotaWindowEnd,
      },
    };
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(usage, null, 2)}\n`, (error) =>
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
