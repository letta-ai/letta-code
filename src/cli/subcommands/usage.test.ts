import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const started = Date.now();
  const preload = resolve("scripts/usage-startup-preload.cjs");
  await mkdir(resolve("artifacts/usage-startup"), { recursive: true });
  const traceFile = resolve(`artifacts/usage-startup/trace-${started}.txt`);
  const child = Bun.spawn(
    [
      bundle ? "node" : process.execPath,
      bundle ? "--require" : "--preload",
      preload,
      bundle || "src/index.ts",
      ...args,
    ],
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
        LETTA_DEBUG_TIMINGS: "1",
        LETTA_TIMING_TRACE_FILE: traceFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  console.error(
    `[usage-trace] spawned pid=${child.pid} args=${JSON.stringify(args)} at=${new Date().toISOString()}`,
  );
  const sampleTimer = setTimeout(async () => {
    console.error(
      `[usage-trace] still running pid=${child.pid} elapsed_ms=${Date.now() - started}`,
    );
    console.error(
      await readFile(traceFile, "utf8").catch(() => "preload has not run"),
    );
    if (process.platform === "darwin") {
      Bun.spawn(
        [
          "/usr/bin/sample",
          String(child.pid),
          "1",
          "10",
          "-file",
          resolve(`artifacts/usage-startup/sample-${child.pid}.txt`),
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
    }
  }, 8_000);
  async function capture(stream: ReadableStream<Uint8Array>, label: string) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      console.error(
        `[usage-trace] pid=${child.pid} elapsed_ms=${Date.now() - started} ${label}: ${Buffer.from(chunk).toString()}`,
      );
    }
    return Buffer.concat(chunks).toString();
  }
  const [stdout, stderr, code] = await Promise.all([
    capture(child.stdout, "stdout"),
    capture(child.stderr, "stderr"),
    child.exited,
  ]);
  clearTimeout(sampleTimer);
  console.error(await readFile(traceFile, "utf8").catch(() => "no trace file"));
  console.error(
    `[usage-trace] completed pid=${child.pid} code=${code} elapsed_ms=${Date.now() - started}`,
  );
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
