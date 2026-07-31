import { expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPackageManagerProcessFactory,
  type PackageManagerProcessFactory,
} from "@/utils/package-manager-spawn";

function createChildProcess(): ChildProcess {
  return new EventEmitter() as ChildProcess;
}

test.each(["npm.cmd", "npm.bat"])(
  "selects the Windows shim launcher for %s",
  (command) => {
    const child = createChildProcess();
    const calls: Array<{
      args: string[];
      command: string;
      options: SpawnOptions;
    }> = [];
    const nativeSpawn: PackageManagerProcessFactory = () => {
      throw new Error("spawn EINVAL");
    };
    const windowsSpawn: PackageManagerProcessFactory = (
      command,
      args,
      options,
    ) => {
      calls.push({ args, command, options });
      return child;
    };

    const launcher = getPackageManagerProcessFactory({
      nativeSpawn,
      platform: "win32",
      windowsSpawn,
    });

    expect(
      launcher(command, ["install", "pkg@1.0.0"], { stdio: "ignore" }),
    ).toBe(child);
    expect(calls).toEqual([
      {
        command,
        args: ["install", "pkg@1.0.0"],
        options: { stdio: "ignore" },
      },
    ]);
  },
);

test.skipIf(process.platform !== "win32")(
  "executes a cmd shim with argument boundaries intact on Windows",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "letta-package-manager-spawn-"));
    const scriptPath = join(root, "print-args.cjs");
    const shimPath = join(root, "npm.cmd");
    writeFileSync(
      scriptPath,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    writeFileSync(shimPath, '@echo off\r\nnode "%~dp0\\print-args.cjs" %*\r\n');

    try {
      const launcher = getPackageManagerProcessFactory();
      const child = launcher(shimPath, ["package name", "literal&value"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
      child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });

      expect(code).toBe(0);
      expect(stderr.join("")).toBe("");
      expect(JSON.parse(stdout.join(""))).toEqual([
        "package name",
        "literal&value",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("uses native spawn for non-shim commands on Windows", () => {
  const child = createChildProcess();
  const calls: Array<{
    args: string[];
    command: string;
    options: SpawnOptions;
  }> = [];
  const nativeSpawn: PackageManagerProcessFactory = (
    command,
    args,
    options,
  ) => {
    calls.push({ args, command, options });
    return child;
  };
  const windowsSpawn: PackageManagerProcessFactory = () => {
    throw new Error("windows launcher should not run");
  };

  const launcher = getPackageManagerProcessFactory({
    nativeSpawn,
    platform: "win32",
    windowsSpawn,
  });

  expect(launcher("bun", ["add", "pkg@1.0.0"], { cwd: "/tmp" })).toBe(child);
  expect(calls).toEqual([
    {
      command: "bun",
      args: ["add", "pkg@1.0.0"],
      options: { cwd: "/tmp" },
    },
  ]);
});

test("keeps native spawn selected off Windows", () => {
  const child = createChildProcess();
  const calls: Array<{
    args: string[];
    command: string;
    options: SpawnOptions;
  }> = [];
  const nativeSpawn: PackageManagerProcessFactory = (
    command,
    args,
    options,
  ) => {
    calls.push({ args, command, options });
    return child;
  };
  const windowsSpawn: PackageManagerProcessFactory = () => {
    throw new Error("windows launcher should not run");
  };

  const launcher = getPackageManagerProcessFactory({
    nativeSpawn,
    platform: "linux",
    windowsSpawn,
  });

  expect(launcher("npm", ["install", "pkg@1.0.0"], { cwd: "/tmp" })).toBe(
    child,
  );
  expect(calls).toEqual([
    {
      command: "npm",
      args: ["install", "pkg@1.0.0"],
      options: { cwd: "/tmp" },
    },
  ]);
});
