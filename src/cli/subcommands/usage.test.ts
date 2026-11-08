import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "letta-usage-"));
  await mkdir(join(home, ".letta"));
  await writeFile(
    join(home, ".letta", "settings.json"),
    JSON.stringify({ preferredBackendMode: "local" }),
  );
});
afterAll(async () => rm(home, { recursive: true, force: true }));

async function cli(args: string[], baseURL = "https://api.letta.com") {
  const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
  const child = Bun.spawn(
    [bundle ? "node" : process.execPath, bundle || "src/index.ts", ...args],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LETTA_LOCAL_BACKEND_DIR: join(home, "backend"),
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: undefined,
        LETTA_BASE_URL: baseURL,
        LETTA_API_KEY:
          baseURL === "https://api.letta.com" ? "" : "usage-test-key",
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

// macOS CI can exceed the 15s unit default on this first CLI subprocess.
// Allow the same 30s subprocess budget as the neighboring model CLI tests.
test("usage help exits before account lookup even with local default", async () => {
  const result = await cli(["usage", "--help"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("letta usage");
  expect(result.stdout).toContain("Markdown overview");
}, 30_000);

test.each([{ prefix: [] }, { prefix: ["--backend", "local"] }])(
  "usage reports BYOK for local backend selection %j without auth",
  async ({ prefix }) => {
    const result = await cli([...prefix, "usage"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "Running on local backend. Model usage requires BYOK.\n",
    );
    expect(result.stderr).toBe("");
  },
);

test.each([
  { args: ["--agent", "agent-unused"] },
  { args: ["extra"] },
  { args: ["--unknown"] },
])(
  "usage rejects unsupported arguments %j before account lookup",
  async ({ args }) => {
    const result = await cli(["usage", ...args]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"error":');
  },
);

// Exercise the real CLI, HTTP metadata decoding, and stdout formatting together.
// Empty buckets are deliberate: exhaustion alone must not hide a legacy quota.
test.each([false, true, undefined])(
  "usage displays quota unless modelQuotaActive is explicitly false (%s)",
  async (modelQuotaActive) => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/metadata/balance") {
          return Response.json({ total_balance: 1234, billing_tier: "pro" });
        }
        if (path === "/v1/organizations/self/quotas") {
          return Response.json({
            modelQuotaActive,
            lettaTier: { bucket: "empty", dailyBucket: "empty" },
            quotaWindowEnd: "2026-11-08T20:00:00.000Z",
            dailyQuotaWindowEnd: "2026-11-09T00:00:00.000Z",
          });
        }
        return new Response("Unexpected request", { status: 404 });
      },
    });
    try {
      const result = await cli(
        ["--backend", "cloud", "usage"],
        server.url.origin,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Current plan: pro");
      expect(result.stdout).toContain("* Balance: 1234 credits");
      if (modelQuotaActive === false) {
        expect(result.stdout).not.toContain("Usage Quota");
        expect(result.stdout).not.toContain("Bucket");
        expect(result.stdout).not.toContain("Window End");
      } else {
        expect(result.stdout).toContain("## Usage Quota (`letta/*` models)");
        expect(result.stdout).toContain("empty (daily: empty)");
        expect(result.stdout).toContain(
          "Quota Window End: 2026-11-08T20:00:00.000Z",
        );
        expect(result.stdout).toContain(
          "Daily Quota Window End: 2026-11-09T00:00:00.000Z",
        );
      }
    } finally {
      server.stop(true);
    }
  },
  30_000,
);
