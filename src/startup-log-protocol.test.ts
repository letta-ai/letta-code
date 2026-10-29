import { beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const root = process.cwd();
const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const marker = `\n[letta-startup-end:${token}]\n`;
const unixTest = process.platform === "win32" ? test.skip : test;

beforeAll(() => {
  if (process.platform === "win32") return;
  // Exercise the published build pipeline, not a mocked or test-only entrypoint.
  const result = spawnSync("bun", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`CLI build failed\n${result.stdout}\n${result.stderr}`);
  }
}, 130_000);

for (const runtime of ["bun", "node"]) {
  for (const enabled of [true, false]) {
    unixTest(
      `${runtime} CLI with ${enabled ? "Cloud marker" : "no marker"}: real registration and immediate legacy WebSocket input`,
      async () => {
        const home = await mkdtemp(join(root, ".startup-protocol-test-"));
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            const url = new URL(request.url);
            if (url.pathname === "/ws") {
              if (server.upgrade(request)) return;
              return new Response("Expected WebSocket", { status: 400 });
            }
            if (url.pathname === "/v1/environments/register") {
              return Response.json({
                connectionId: "startup-protocol-test",
                wsUrl: `ws://127.0.0.1:${server.port}/ws`,
                supportsSplitStatusChannels: false,
              });
            }
            return Response.json({ error: "test endpoint" }, { status: 404 });
          },
          websocket: {
            open(socket) {
              // Send immediately, without waiting for any ready/Connected prose.
              socket.send(
                JSON.stringify({
                  type: "input",
                  request_id: "startup-early",
                  runtime: {
                    agent_id: "test-agent",
                    conversation_id: "test-conv",
                  },
                  payload: {
                    kind: "create_message",
                    messages: [
                      { role: "user", content: "REAL_WS_USER_PRIVATE" },
                    ],
                  },
                }),
              );
            },
            message() {},
          },
        });
        const env = createIsolatedCliTestEnv({
          HOME: home,
          LETTA_BASE_URL: `http://127.0.0.1:${server.port}`,
          LETTA_API_KEY: "test-key-not-a-secret",
          IGNORE_SELF_HOSTED_LISTENER_ERROR: "1",
          LETTA_STARTUP_LOG_MARKER: enabled ? token : undefined,
          LETTA_STARTUP_LOG_OWNER_PID: undefined,
          LETTA_DEBUG: "1",
          LETTA_CODE_TELEM: "0",
          DO_NOT_TRACK: "1",
          LETTA_DISABLE_CRON_SCHEDULER: "1",
          LETTA_DISABLE_MODS: "1",
        });
        const child = spawn(
          "sh",
          [
            "-c",
            (enabled ? "export LETTA_STARTUP_LOG_OWNER_PID=$$; " : "") +
              'exec "$@" 2>&1',
            "listener",
            runtime,
            ...(runtime === "bun"
              ? [`--config=${join(root, "bunfig.toml")}`]
              : []),
            join(root, runtime === "bun" ? "src/index.ts" : "letta.js"),
            "server",
            "--debug",
            "--computer-name",
            "startup-protocol-test",
          ],
          { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error(`Timed out\n${output}`)),
              25_000,
            );
            const finish = () => {
              if (
                output.includes("REAL_WS_USER_PRIVATE") &&
                output.includes("Connected. Awaiting instructions.")
              ) {
                clearTimeout(timeout);
                resolve();
              }
            };
            child.stdout.on("data", (data) => {
              output += data.toString();
              finish();
            });
            child.on("error", (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            child.on("close", (code) => {
              clearTimeout(timeout);
              reject(new Error(`Listener exited ${code}\n${output}`));
            });
          });
          if (enabled) {
            expect(output.split(marker)).toHaveLength(2);
            const [startup, content] = output.split(marker);
            expect(startup).toContain("Registered successfully");
            expect(startup).not.toContain("REAL_WS_USER_PRIVATE");
            expect(startup).not.toContain("Connected. Awaiting instructions.");
            expect(content).toContain("REAL_WS_USER_PRIVATE");
          } else {
            expect(output).not.toContain("[letta-startup-end:");
            expect(output).toContain("REAL_WS_USER_PRIVATE");
          }
        } finally {
          child.kill("SIGKILL");
          await new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("close", () => resolve());
          });
          server.stop(true);
          await rm(home, { recursive: true, force: true });
        }
      },
      35_000,
    );
  }
}

unixTest(
  "package capability remains readable when Node fails before importing the runtime",
  async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.lettaStartupLogProtocol).toBe(1);
    const result = spawnSync(
      "node",
      [
        "--import",
        "file:///missing-letta-startup-import.mjs",
        join(root, "letta.js"),
        "--version",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: createIsolatedCliTestEnv({ LETTA_STARTUP_LOG_MARKER: token }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stdout + result.stderr).not.toContain(marker);
  },
);
