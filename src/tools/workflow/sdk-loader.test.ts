import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeInstalledSdkDirs } from "./sdk-loader.ts";

function installFakeSdk(root: string): string {
  const dir = join(root, "node_modules", "@letta-ai", "letta-agent-sdk");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@letta-ai/letta-agent-sdk",
      type: "module",
      exports: { ".": { default: "./dist/index.js" } },
    }),
  );
  writeFileSync(
    join(dir, "dist", "index.js"),
    "export class LettaAgentClient { constructor(o) { this.options = o; } query() { return { conversationId: null, agentId: null, close() {}, async interrupt() {} }; } }\n",
  );
  return dir;
}

describe("probeInstalledSdkDirs", () => {
  test("finds installs above each start directory, nearest first, without duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-probe-"));
    try {
      const outer = installFakeSdk(root);
      const inner = installFakeSdk(join(root, "pkg"));
      const nested = join(root, "pkg", "src", "deep");
      mkdirSync(nested, { recursive: true });
      expect(probeInstalledSdkDirs([nested, join(root, "pkg")])).toEqual([
        inner,
        outer,
      ]);
      expect(probeInstalledSdkDirs([join(root, "elsewhere")])).toEqual([outer]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns nothing when no install exists on the path", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-probe-empty-"));
    try {
      // The temp root itself has no node_modules; ancestors of tmpdir are
      // not expected to either, but tolerate a machine where they do.
      const found = probeInstalledSdkDirs([root]);
      expect(found.every((dir) => !dir.startsWith(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// realpathSync.native: on Windows the plain form keeps 8.3 short names
// (RUNNER~1) while the subprocess's process.cwd() reports the long name; on
// macOS both resolve the /var -> /private/var symlink.
describe("loadAgentSdk after a late install", () => {
  test("loads through the probe when the resolver already cached a miss", async () => {
    // A subprocess whose loader copy and cwd start without the SDK: the
    // resolver paths fail (and may be cached), then the package appears on
    // disk and the next load must still succeed via the direct probe.
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "sdk-late-install-")),
    );
    try {
      // An empty node_modules keeps Bun from auto-installing the package
      // from its cache, which would defeat the "not installed yet" setup.
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "package.json"), '{"name":"scratch"}');
      copyFileSync(
        join(import.meta.dir, "sdk-loader.ts"),
        join(root, "src", "sdk-loader.ts"),
      );
      writeFileSync(
        join(root, "src", "types.ts"),
        "export type SdkClient = unknown;\n",
      );
      const sdkDir = join(root, "node_modules", "@letta-ai", "letta-agent-sdk");
      writeFileSync(
        join(root, "probe.ts"),
        `
        import { loadAgentSdk } from "./src/sdk-loader.ts";
        import { mkdirSync, writeFileSync } from "node:fs";
        const outcome = (p) => p.then(() => "loaded", (e) => e.message);
        const first = await outcome(loadAgentSdk());
        const dir = ${JSON.stringify(sdkDir)};
        mkdirSync(dir + "/dist", { recursive: true });
        writeFileSync(dir + "/package.json", JSON.stringify({ type: "module", exports: { ".": { default: "./dist/index.js" } } }));
        writeFileSync(dir + "/dist/index.js", "export class LettaAgentClient { constructor(o) { this.options = o; } }");
        const second = await outcome(loadAgentSdk());
        console.log(JSON.stringify({ first, second }));
        `,
      );
      const proc = Bun.spawnSync({
        cmd: [process.execPath, "--no-install", "probe.ts"],
        cwd: root,
        env: { ...process.env, LETTA_AGENT_SDK_PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const line = proc.stdout.toString().trim().split("\n").at(-1) ?? "";
      const { first, second } = JSON.parse(line) as {
        first: string;
        second: string;
      };
      expect(first).toContain("Could not load @letta-ai/letta-agent-sdk");
      expect(first).toContain("bun add");
      expect(second).toBe("loaded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("names the installed path and says to restart when nothing loads", async () => {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "sdk-broken-install-")),
    );
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "package.json"), '{"name":"scratch"}');
      copyFileSync(
        join(import.meta.dir, "sdk-loader.ts"),
        join(root, "src", "sdk-loader.ts"),
      );
      writeFileSync(
        join(root, "src", "types.ts"),
        "export type SdkClient = unknown;\n",
      );
      // Present on disk but its entry throws, so every specifier fails.
      const dir = installFakeSdk(root);
      writeFileSync(join(dir, "dist", "index.js"), "throw new Error('boom')");
      writeFileSync(
        join(root, "probe.ts"),
        `
        import { loadAgentSdk } from "./src/sdk-loader.ts";
        console.log(JSON.stringify(await loadAgentSdk().then(() => "loaded", (e) => e.message)));
        `,
      );
      const proc = Bun.spawnSync({
        cmd: [process.execPath, "--no-install", "probe.ts"],
        cwd: root,
        env: { ...process.env, LETTA_AGENT_SDK_PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const message = JSON.parse(
        proc.stdout.toString().trim().split("\n").at(-1) ?? '""',
      ) as string;
      expect(message).toContain(`is installed at ${dir}`);
      expect(message).toContain("Restart the CLI");
      expect(message).not.toContain("bun add");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
