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

test("usage reads only plan and credits even when quota is unavailable", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/v1/metadata/balance") {
        return Response.json({ total_balance: -12.5, billing_tier: "pro" });
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
    expect(result.stdout).toBe(`# Letta usage overview
Current plan: pro

## Usage Credits (non-BYOK models)
* Balance: -12.5 credits
`);
    expect(requests).toEqual(["/v1/metadata/balance"]);
  } finally {
    server.stop(true);
  }
}, 30_000);
