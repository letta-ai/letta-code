import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("usage CLI reads live account credits and rejects invalid auth", async () => {
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

    const denied = await cli("invalid-usage-cli-test-key");
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toMatch(/API error \((401|403)\)/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
