import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("computers list drains async work and exits successfully without hanging", async () => {
  const home = await mkdtemp(join(tmpdir(), "letta-subcommand-exit-"));
  const preload = join(home, "exit-probe.cjs");
  await writeFile(
    preload,
    `process.once("beforeExit", () => {
      setTimeout(() => process.stderr.write("async-work-drained\\n"), 10);
    });`,
  );
  const response = { connections: [], hasNextPage: false };
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(response),
  });
  const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
  const child = Bun.spawn(
    [
      bundle ? "node" : process.execPath,
      "--require",
      preload,
      bundle || "src/index.ts",
      "computers",
      "list",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: home,
        LETTA_API_KEY: "test-key",
        LETTA_BASE_URL: server.url.toString().replace(/\/$/, ""),
        LETTA_DEBUG: "0",
        LETTA_DESKTOP_CREDENTIALS_IPC: undefined,
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(response);
    expect(stderr).toContain("async-work-drained");
  } finally {
    clearTimeout(timeout);
    child.kill();
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
