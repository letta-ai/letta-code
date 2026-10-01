import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const unixDescribe = process.platform === "win32" ? describe.skip : describe;
const token = "87654321-1234-4567-89ab-123456789abc";
const marker = `\n[letta-startup-end:${token}]\n`;
const source = join(root, "src/test-utils/startup-log-boundary-scenario.ts");
let directory: string;
let bundle: string;

beforeAll(async () => {
  directory = await mkdtemp(join(root, ".listener-startup-test-"));
  bundle = join(directory, "scenario.js");
  const result = await Bun.build({
    entrypoints: [source],
    outdir: directory,
    naming: "scenario.js",
    target: "node",
    format: "esm",
    external: ["ws", "@vscode/ripgrep", "node-pty", "grammy"],
    define: { __USE_MAGICK__: "false" },
    loader: { ".md": "text", ".mdx": "text", ".txt": "text" },
  });
  expect(result.success).toBe(true);
}, 60_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const runtime of ["bun", "node"]) {
  unixDescribe(`${runtime} real listener startup ordering`, () => {
    function run(mode: string, enabled = true): string {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: directory,
        LETTA_DEBUG: "1",
        LETTA_CODE_TELEM: "0",
        DO_NOT_TRACK: "1",
        LETTA_DISABLE_CRON_SCHEDULER: "1",
      };
      delete env.LETTA_STARTUP_LOG_MARKER;
      delete env.LETTA_STARTUP_LOG_OWNER_PID;
      if (enabled) env.LETTA_STARTUP_LOG_MARKER = token;
      if (mode === "invalid-owner")
        env.LETTA_STARTUP_LOG_OWNER_PID = "not-a-pid";
      const result = spawnSync(
        "sh",
        [
          "-c",
          (enabled && mode !== "invalid-owner"
            ? "export LETTA_STARTUP_LOG_OWNER_PID=$$; "
            : "") +
            (mode === "failure"
              ? 'exec "$@" 2>&1 1</dev/null'
              : 'exec "$@" 2>&1'),
          "listener",
          runtime,
          ...(runtime === "bun"
            ? [`--config=${join(root, "bunfig.toml")}`]
            : []),
          runtime === "bun" ? source : bundle,
          mode,
        ],
        { cwd: directory, env, encoding: "utf8", timeout: 30_000 },
      );
      if (result.status !== 0) {
        throw new Error(
          `Listener scenario failed: ${result.error ?? result.status}\n${result.stdout}`,
        );
      }
      return result.stdout;
    }

    function expectSealed(output: string): [string, string] {
      expect(output.split(marker)).toHaveLength(2);
      const [startup, content] = output.split(marker) as [string, string];
      expect(startup).toContain("STARTUP_DIAGNOSTIC");
      expect(startup).not.toContain("PRIVATE");
      expect(content).toContain("CONNECTED_PRIVATE");
      expect(content).toContain("EARLY_USER_PRIVATE");
      expect(content).toContain("DONE");
      return [startup, content];
    }

    test("seals synchronously before onConnected and immediate gateway ingress; reconnect emits no second marker", () => {
      const [, content] = expectSealed(run("connected"));
      expect(content.indexOf("CONNECTED_PRIVATE")).toBeLessThan(
        content.indexOf("CALLER_RETURNED"),
      );
    });

    test("legacy early user ingress seals before full-input debug/event logs, not at onConnected", () => {
      const [startup, content] = expectSealed(run("early"));
      expect(startup).toContain("AFTER_PONG_STARTUP");
      expect(content.indexOf("EARLY_USER_PRIVATE")).toBeLessThan(
        content.indexOf("BEFORE_CONNECTED"),
      );
      expect(content.indexOf("BEFORE_CONNECTED")).toBeLessThan(
        content.indexOf("CONNECTED_PRIVATE"),
      );
    });

    test("malformed early frames cannot enter startup capture through unparseable-frame logs", () => {
      const [, content] = expectSealed(run("malformed"));
      expect(content).toContain("MALFORMED_PRIVATE");
      expect(content).toContain("_ws_unparseable");
    });

    test("ready frames with extra fields seal before their lifecycle event log", () => {
      const [startup, content] = expectSealed(run("ready"));
      expect(startup).not.toContain("READY_EXTRA_PRIVATE");
      expect(content).toContain("READY_EXTRA_PRIVATE");
    });

    test("real marker IO failure blocks both ingress and connected callbacks, including retries", () => {
      const output = run("failure");
      expect(output).toContain("BLOCKED_ALL_CONTENT");
      expect(output).not.toContain("PRIVATE");
      expect(output).not.toContain("[letta-startup-end:");
    });

    test("malformed owner blocks ingress and connected callbacks before any content", () => {
      const output = run("invalid-owner");
      expect(output).toContain("BLOCKED_ALL_CONTENT");
      expect(output).not.toContain("PRIVATE");
      expect(output).not.toContain("[letta-startup-end:");
    });

    test("without Cloud opt-in the listener retains its existing content logging", () => {
      const output = run("early", false);
      expect(output).toContain("EARLY_USER_PRIVATE");
      expect(output).toContain("CONNECTED_PRIVATE");
      expect(output).not.toContain("[letta-startup-end:");
    });
  });
}
