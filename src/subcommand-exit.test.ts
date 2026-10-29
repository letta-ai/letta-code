import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.each([false, true])(
  "computers list drains and exits with Desktop IPC=%s",
  async (desktopIpc) => {
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
    const child = spawn(
      bundle ? "node" : process.execPath,
      ["--require", preload, bundle || "src/index.ts", "computers", "list"],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: home,
          LETTA_API_KEY: "test-key",
          LETTA_BASE_URL: server.url.toString().replace(/\/$/, ""),
          LETTA_DEBUG: "0",
          LETTA_DESKTOP_CREDENTIALS_IPC: desktopIpc ? "1" : undefined,
          LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0",
        },
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          ...(desktopIpc ? ["ipc" as const] : []),
        ],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (data) => {
      stdout += data;
    });
    child.stderr?.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    child.on("message", (message) => {
      if ((message as { type?: string }).type === "desktop_credentials_ready") {
        child.send({ type: "desktop_credentials", accessToken: "test-key" });
      }
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      const code = await exited;
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ...response, nextCursor: null });
      expect(stderr).toContain("async-work-drained");
    } finally {
      clearTimeout(timeout);
      child.kill();
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000,
);
