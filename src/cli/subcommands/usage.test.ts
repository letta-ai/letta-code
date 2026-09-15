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

async function cli(args: string[]) {
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
        LETTA_BASE_URL: "https://api.letta.com",
        LETTA_API_KEY: "",
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

test("usage help exits before account lookup even with local default", async () => {
  const result = await cli(["usage", "--help"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("letta usage");
  expect(result.stdout).toContain("Markdown overview");
});

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
