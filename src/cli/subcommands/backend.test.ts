import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "letta-backend-"));
});
afterEach(async () => rm(home, { recursive: true, force: true }));

async function cli(args: string[]) {
  const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
  const child = Bun.spawn(
    [bundle ? "node" : process.execPath, bundle || "src/index.ts", ...args],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: createIsolatedCliTestEnv({
        HOME: home,
        USERPROFILE: home,
        LETTA_LOCAL_BACKEND_DIR: join(home, "backend"),
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: undefined,
        LETTA_BASE_URL: "https://api.letta.com",
        LETTA_API_KEY: "",
        LETTA_SKIP_KEYCHAIN_CHECK: "1",
        LETTA_DEBUG: "0",
        LETTA_DISABLE_MODS: "1",
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timeout);
  }
}

async function savedPreference() {
  const settings = JSON.parse(
    await readFile(join(home, ".letta", "settings.json"), "utf8"),
  );
  return settings.preferredBackendMode;
}

test("fresh credentialless backend reports Cloud, not an automatic Local default", async () => {
  const result = await cli(["backend"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Default backend: Letta Cloud (cloud)");
  expect(result.stdout).not.toContain("Proceed locally selected");
}, 20_000);

test("backend local and cloud persist across CLI processes", async () => {
  for (const [mode, stored, label] of [
    ["local", "local", "local mode (local)"],
    ["cloud", "api", "Letta Cloud (cloud)"],
  ] as const) {
    const changed = await cli(["backend", mode]);
    expect(changed.code, changed.stderr).toBe(0);
    expect(await savedPreference()).toBe(stored);
    const nextProcess = await cli(["backend"]);
    expect(nextProcess.code, nextProcess.stderr).toBe(0);
    expect(nextProcess.stdout).toContain(`Default backend: ${label}`);
  }
}, 20_000);

test.each([
  { saved: "cloud", override: "local", stored: "api" },
  { saved: "local", override: "cloud", stored: "local" },
])(
  "--backend $override takes effect without changing saved $saved preference",
  async ({ saved, override, stored }) => {
    const changed = await cli(["backend", saved]);
    expect(changed.code, changed.stderr).toBe(0);

    // Usage distinguishes the active backend without making a provider request:
    // Local reports BYOK, whereas credentialless Cloud fails authentication.
    const result = await cli(["--backend", override, "usage"]);
    if (override === "local") {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Running on local backend.");
    } else {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Missing LETTA_API_KEY");
      expect(result.stdout).not.toContain("Running on local backend.");
    }
    expect(await savedPreference()).toBe(stored);

    const nextProcess = await cli(["backend"]);
    expect(nextProcess.code, nextProcess.stderr).toBe(0);
    expect(nextProcess.stdout).toContain(`(${saved})`);
  },
  20_000,
);

test("fresh credentialless headless startup requires Cloud authentication", async () => {
  const result = await cli(["-p", "Do not run without authentication"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Missing LETTA_API_KEY");
  expect(result.stderr).toContain("Headless mode requires an API key");
}, 20_000);
