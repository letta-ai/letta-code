import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelQuotaMetadata } from "@/backend/api/metadata";

test("usage CLI reads live credits and model quota and rejects invalid auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "letta-usage-api-"));
  const baseURL = process.env.LETTA_BASE_URL || "https://api.letta.com";
  async function cli(apiKey: string) {
    const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
    const child = Bun.spawn(
      [
        bundle ? "node" : process.execPath,
        bundle || "src/index.ts",
        "--backend",
        "cloud",
        "usage",
      ],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LETTA_API_KEY: apiKey,
          LETTA_BASE_URL: baseURL,
          LETTA_DEBUG: "0",
          LETTA_DISABLE_MODS: "1",
          LETTA_SKIP_KEYCHAIN_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }
  try {
    const apiKey = process.env.LETTA_API_KEY;
    expect(apiKey).toBeTruthy();
    if (!apiKey) throw new Error("LETTA_API_KEY is required");
    const result = await cli(apiKey);
    expect(result.code, result.stderr).toBe(0);
    const balance = JSON.parse(result.stdout);
    expect(typeof balance.total_balance).toBe("number");
    expect(typeof balance.monthly_credit_balance).toBe("number");
    expect(typeof balance.purchased_credit_balance).toBe("number");
    expect(typeof balance.billing_tier).toBe("string");
    expect(balance.total_balance).toBeCloseTo(
      balance.monthly_credit_balance + balance.purchased_credit_balance,
      5,
    );
    expect(balance.credit_scope).toBe("organization");
    const quota = balance.model_quota;
    const buckets = ["empty", "low", "medium", "high", "full"];
    for (const tier of ["basic", "standard", "lettaTier", "premium"]) {
      expect(buckets).toContain(quota[tier].bucket);
      if (quota[tier].dailyBucket !== undefined) {
        expect(buckets).toContain(quota[tier].dailyBucket);
      }
    }
    expect(Number.isFinite(Date.parse(quota.quotaWindowEnd))).toBe(true);
    if (quota.dailyQuotaWindowEnd !== undefined) {
      expect(Number.isFinite(Date.parse(quota.dailyQuotaWindowEnd))).toBe(true);
    }
    const response = await fetch(`${baseURL}/v1/organizations/self/quotas`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(200);
    const authoritative = (await response.json()) as ModelQuotaMetadata;
    expect(quota.scope).toBe(
      authoritative.isUserScoped === true
        ? "user"
        : authoritative.isUserScoped === false
          ? "organization"
          : "unknown",
    );
    expect(quota.seatTier).toBe(authoritative.seatTier);

    const denied = await cli("invalid-usage-cli-test-key");
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toMatch(/API error \((401|403)\)/);

    // Exercise saved OAuth initialization against the real token endpoint.
    // A deliberately invalid refresh token must fail there, not use the expired
    // access token for the balance or quota request.
    await mkdir(join(home, ".letta"), { recursive: true });
    await writeFile(
      join(home, ".letta", "settings.json"),
      JSON.stringify({
        env: { LETTA_API_KEY: "expired-usage-cli-test-token" },
        refreshToken: "invalid-usage-cli-test-refresh-token",
        tokenExpiresAt: 1,
      }),
    );
    const expired = await cli("");
    expect(expired.code).toBe(1);
    expect(expired.stdout).toBe("");
    expect(expired.stderr).toContain("Failed to refresh access token");
    const overridden = await cli(apiKey);
    expect(overridden.code, overridden.stderr).toBe(0);
    expect(JSON.parse(overridden.stdout).model_quota.scope).toBe(quota.scope);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
