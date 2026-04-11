import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  __testOverrideChannelRuntimeDeps,
  ensureChannelRuntimeInstalled,
  getChannelRuntimeDir,
  getChannelRuntimePackagePath,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} = await import("../../channels/runtimeDeps");

function writeFakeGrammyModule(runtimeDir: string): void {
  const moduleDir = join(runtimeDir, "node_modules", "grammy");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(
    join(moduleDir, "package.json"),
    JSON.stringify(
      {
        name: "grammy",
        type: "module",
        exports: "./index.js",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(moduleDir, "index.js"),
    "export class Bot { static label = 'fake-grammy'; }\n",
  );
}

let runtimeRoot: string;

beforeEach(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "letta-channel-runtime-"));
  __testOverrideChannelRuntimeDeps({ runtimeRoot });
});

afterEach(() => {
  __testOverrideChannelRuntimeDeps(null);
  rmSync(runtimeRoot, { recursive: true, force: true });
});

test("loadChannelRuntimeModule throws a friendly install hint when runtime is missing", async () => {
  expect(isChannelRuntimeInstalled("telegram")).toBe(false);
  await expect(loadChannelRuntimeModule("telegram")).rejects.toThrow(
    "letta channels install telegram",
  );
});

test("loadChannelRuntimeModule resolves a module from the channel runtime directory", async () => {
  const runtimeDir = getChannelRuntimeDir("telegram");
  writeFakeGrammyModule(runtimeDir);

  expect(isChannelRuntimeInstalled("telegram")).toBe(true);

  const mod = await loadChannelRuntimeModule<{ Bot: { label: string } }>(
    "telegram",
  );
  expect(mod.Bot.label).toBe("fake-grammy");
});

test("installChannelRuntime writes a manifest and invokes npm in the runtime directory", async () => {
  const spawnCalls: Array<{
    cmd: string;
    args: string[];
    cwd?: string;
  }> = [];

  const spawnImpl = mock(
    (cmd: string, args: string[], opts?: { cwd?: string }) => {
      spawnCalls.push({ cmd, args, cwd: opts?.cwd });
      const proc = new EventEmitter();
      queueMicrotask(() => {
        proc.emit("exit", 0);
      });
      return proc as unknown as ReturnType<typeof mock>;
    },
  );

  __testOverrideChannelRuntimeDeps({
    runtimeRoot,
    spawnImpl: spawnImpl as never,
    packageManager: "npm",
  });

  await installChannelRuntime("telegram");

  const manifest = JSON.parse(
    readFileSync(getChannelRuntimePackagePath("telegram"), "utf-8"),
  ) as {
    name: string;
    private: boolean;
  };

  expect(manifest).toEqual(
    expect.objectContaining({
      name: "letta-channel-runtime-telegram",
      private: true,
    }),
  );
  expect(spawnCalls).toEqual([
    {
      cmd: "npm",
      args: ["install", "--no-save", "grammy@1.42.0"],
      cwd: getChannelRuntimeDir("telegram"),
    },
  ]);
});

test("installChannelRuntime uses bun add --no-save for bun installs", async () => {
  const spawnCalls: Array<{
    cmd: string;
    args: string[];
    cwd?: string;
  }> = [];

  const spawnImpl = mock(
    (cmd: string, args: string[], opts?: { cwd?: string }) => {
      spawnCalls.push({ cmd, args, cwd: opts?.cwd });
      const proc = new EventEmitter();
      queueMicrotask(() => {
        proc.emit("exit", 0);
      });
      return proc as unknown as ReturnType<typeof mock>;
    },
  );

  __testOverrideChannelRuntimeDeps({
    runtimeRoot,
    spawnImpl: spawnImpl as never,
    packageManager: "bun",
  });

  await installChannelRuntime("telegram");

  expect(spawnCalls).toEqual([
    {
      cmd: "bun",
      args: ["add", "--no-save", "grammy@1.42.0"],
      cwd: getChannelRuntimeDir("telegram"),
    },
  ]);
});

test("installChannelRuntime uses pnpm add for pnpm installs", async () => {
  const spawnCalls: Array<{
    cmd: string;
    args: string[];
    cwd?: string;
  }> = [];

  const spawnImpl = mock(
    (cmd: string, args: string[], opts?: { cwd?: string }) => {
      spawnCalls.push({ cmd, args, cwd: opts?.cwd });
      const proc = new EventEmitter();
      queueMicrotask(() => {
        proc.emit("exit", 0);
      });
      return proc as unknown as ReturnType<typeof mock>;
    },
  );

  __testOverrideChannelRuntimeDeps({
    runtimeRoot,
    spawnImpl: spawnImpl as never,
    packageManager: "pnpm",
  });

  await installChannelRuntime("telegram");

  expect(spawnCalls).toEqual([
    {
      cmd: "pnpm",
      args: ["add", "grammy@1.42.0"],
      cwd: getChannelRuntimeDir("telegram"),
    },
  ]);
});

test("installChannelRuntime uses cmd shims for npm on Windows", async () => {
  const spawnCalls: Array<{
    cmd: string;
    args: string[];
    cwd?: string;
  }> = [];

  const spawnImpl = mock(
    (cmd: string, args: string[], opts?: { cwd?: string }) => {
      spawnCalls.push({ cmd, args, cwd: opts?.cwd });
      const proc = new EventEmitter();
      queueMicrotask(() => {
        proc.emit("exit", 0);
      });
      return proc as unknown as ReturnType<typeof mock>;
    },
  );

  __testOverrideChannelRuntimeDeps({
    runtimeRoot,
    spawnImpl: spawnImpl as never,
    packageManager: "npm",
    platform: "win32",
  });

  await installChannelRuntime("telegram");

  expect(spawnCalls).toEqual([
    {
      cmd: "npm.cmd",
      args: ["install", "--no-save", "grammy@1.42.0"],
      cwd: getChannelRuntimeDir("telegram"),
    },
  ]);
});

test("ensureChannelRuntimeInstalled skips installation when runtime already exists", async () => {
  writeFakeGrammyModule(getChannelRuntimeDir("telegram"));

  const spawnImpl = mock(() => {
    throw new Error("install should not run");
  });
  __testOverrideChannelRuntimeDeps({
    runtimeRoot,
    spawnImpl: spawnImpl as never,
  });

  const installed = await ensureChannelRuntimeInstalled("telegram");
  expect(installed).toBe(false);
  expect(spawnImpl).not.toHaveBeenCalled();
});
