import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const LATEST_VERSION = "99.0.0";

describe.skipIf(process.platform === "win32")(
  "auto-update process coordination",
  () => {
    let server: Server;
    let registryUrl: string;
    let testDir: string;

    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), "letta-update-lock-test-"));
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ version: LATEST_VERSION }));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test registry did not bind a TCP port");
      }
      registryUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(testDir, { recursive: true, force: true });
    });

    for (const packageManager of ["npm", "pnpm", "bun"] as const) {
      test(`${packageManager} serializes simultaneous startup updates and rechecks the stable global install`, async () => {
        const prefix = join(testDir, "prefix");
        const globalRoot = join(prefix, "lib", "node_modules");
        const packageDir = join(globalRoot, "@letta-ai", "letta-code");
        const entrypointPackageDir =
          packageManager === "pnpm"
            ? join(
                globalRoot,
                ".pnpm",
                "@letta-ai+letta-code@0.0.1",
                "node_modules",
                "@letta-ai",
                "letta-code",
              )
            : packageDir;
        const entrypoint = join(entrypointPackageDir, "letta.js");
        const manifestPath = join(packageDir, "package.json");
        const fakeBinDir = join(testDir, "bin");
        const installLog = join(testDir, "install.log");
        const activeInstallDir = join(testDir, "install-active");
        const lockPath = join(globalRoot, ".letta-update.lock");
        const updaterUrl = pathToFileURL(
          join(process.cwd(), "src", "updater", "auto-update.ts"),
        ).href;

        await mkdir(packageDir, { recursive: true });
        await mkdir(entrypointPackageDir, { recursive: true });
        await mkdir(fakeBinDir, { recursive: true });
        await writeFile(
          manifestPath,
          `${JSON.stringify({ version: "0.0.1" })}\n`,
          "utf8",
        );
        await writeFile(
          entrypoint,
          `
import { checkAndAutoUpdate } from ${JSON.stringify(updaterUrl)};
import { manualUpdate } from ${JSON.stringify(updaterUrl)};
const result = process.env.UPDATE_TEST_MODE === "manual"
  ? await manualUpdate({ progressLog: () => {} })
  : await checkAndAutoUpdate();
console.log(JSON.stringify(result ?? null));
`,
          "utf8",
        );

        const fakePackageManagerPath = join(fakeBinDir, packageManager);
        await writeFile(
          fakePackageManagerPath,
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "prefix") {
  process.stdout.write(process.env.FAKE_PM_PREFIX);
  process.exit(0);
}
if (args[0] === "root") {
  process.stdout.write(process.env.FAKE_PM_ROOT);
  process.exit(0);
}
if (args[0] !== "install" && args[0] !== "add") process.exit(64);
fs.appendFileSync(process.env.FAKE_PM_LOG, "start\\n");
if (!fs.existsSync(process.env.FAKE_PM_LOCK)) {
  fs.appendFileSync(process.env.FAKE_PM_LOG, "missing-lock\\n");
  process.exit(74);
}
try {
  fs.mkdirSync(process.env.FAKE_PM_ACTIVE);
} catch {
  fs.appendFileSync(process.env.FAKE_PM_LOG, "overlap\\n");
  process.exit(73);
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
fs.writeFileSync(
  process.env.FAKE_PM_MANIFEST,
  JSON.stringify({ version: process.env.FAKE_PM_VERSION }) + "\\n",
);
fs.rmSync(process.env.FAKE_PM_ACTIVE, { recursive: true, force: true });
fs.appendFileSync(process.env.FAKE_PM_LOG, "end\\n");
`,
          "utf8",
        );
        await chmod(fakePackageManagerPath, 0o755);

        const env = createIsolatedCliTestEnv({
          PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
          FAKE_PM_ACTIVE: activeInstallDir,
          FAKE_PM_LOG: installLog,
          FAKE_PM_LOCK: lockPath,
          FAKE_PM_MANIFEST: manifestPath,
          FAKE_PM_PREFIX: prefix,
          FAKE_PM_ROOT: globalRoot,
          FAKE_PM_VERSION: LATEST_VERSION,
          DISABLE_AUTOUPDATER: "0",
          LETTA_PACKAGE_MANAGER: packageManager,
          LETTA_UPDATE_INSTALL_REGISTRY_URL: undefined,
          LETTA_UPDATE_PACKAGE_NAME: "@letta-ai/letta-code",
          LETTA_UPDATE_REGISTRY_BASE_URL: registryUrl,
        });

        const runUpdater = (mode: "auto" | "manual") =>
          new Promise<{
            exitCode: number | null;
            stderr: string;
            stdout: string;
          }>((resolve, reject) => {
            const child = spawn(process.execPath, [entrypoint], {
              cwd: process.cwd(),
              env: { ...env, UPDATE_TEST_MODE: mode },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => {
              stdout += String(chunk);
            });
            child.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.once("error", reject);
            child.once("exit", (exitCode) => {
              resolve({ exitCode, stderr, stdout });
            });
          });

        const results = await Promise.all([
          runUpdater("auto"),
          runUpdater("auto"),
        ]);

        for (const result of results) {
          expect(result.exitCode, result.stderr).toBe(0);
        }
        const installEvents = (await readFile(installLog, "utf8"))
          .trim()
          .split("\n");
        expect(installEvents).toEqual(["start", "end"]);
        expect(
          JSON.parse(await readFile(manifestPath, "utf8")) as {
            version: string;
          },
        ).toEqual({ version: LATEST_VERSION });

        const payloads = results.map((result) =>
          JSON.parse(result.stdout.trim()),
        );
        expect(payloads).toEqual([
          { latestVersion: LATEST_VERSION, updateApplied: true },
          { latestVersion: LATEST_VERSION, updateApplied: true },
        ]);
        expect(await readFile(lockPath, "utf8").catch(() => null)).toBeNull();

        await writeFile(
          manifestPath,
          `${JSON.stringify({ version: "0.0.1" })}\n`,
          "utf8",
        );
        await writeFile(installLog, "", "utf8");

        const manualResults = await Promise.all([
          runUpdater("manual"),
          runUpdater("manual"),
        ]);
        for (const result of manualResults) {
          expect(result.exitCode, result.stderr).toBe(0);
        }
        expect((await readFile(installLog, "utf8")).trim().split("\n")).toEqual(
          ["start", "end"],
        );
        const manualPayloads = manualResults.map((result) =>
          JSON.parse(result.stdout.trim()),
        ) as Array<{ message: string; success: boolean }>;
        expect(manualPayloads.every((payload) => payload.success)).toBe(true);
        expect(
          manualPayloads.every((payload) =>
            payload.message.includes("Restart Letta Code"),
          ),
        ).toBe(true);
        expect(await readFile(lockPath, "utf8").catch(() => null)).toBeNull();
      });
    }
  },
);
