import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  __testOverrideNpmManagedModPackageInstaller,
  installGitManagedModPackage,
  installLocalManagedModPackage,
  installNpmManagedModPackage,
  parseGitManagedModPackageInstallSpecifier,
  parseNpmManagedModPackageInstallSpecifier,
  updateGitManagedModPackage,
  updateNpmManagedModPackage,
} from "@/mods/package-installer";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "letta-package-installer-"));
  tempRoots.push(dir);
  return dir;
}

function writeLocalPackage(params: {
  capabilities?: string[];
  entries?: string[];
  name?: string;
  packageRoot: string;
  version?: string;
  writeEntries?: boolean;
}): void {
  const entries = params.entries ?? ["mods/index.ts"];
  mkdirSync(params.packageRoot, { recursive: true });
  if (params.writeEntries !== false) {
    for (const entry of entries) {
      const entryPath = path.join(params.packageRoot, ...entry.split("/"));
      mkdirSync(path.dirname(entryPath), { recursive: true });
      writeFileSync(
        entryPath,
        `export const value = ${JSON.stringify(entry)};\n`,
      );
    }
  }
  writeFileSync(
    path.join(params.packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: params.name ?? "@caren/my-mod",
        version: params.version ?? "0.1.0",
        letta: {
          manifestVersion: 1,
          mods: entries,
          ...(params.capabilities ? { capabilities: params.capabilities } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeInstalledNpmPackage(params: {
  capabilities?: string[];
  cwd: string;
  entries?: string[];
  includeDependency?: boolean;
  name?: string;
  repository?: unknown;
  version?: string;
  withManifest?: boolean;
}): void {
  const packageName = params.name ?? "@caren/my-mod";
  const packageRoot = path.join(
    params.cwd,
    "node_modules",
    ...packageName.split("/"),
  );
  writeLocalPackage({
    capabilities: params.capabilities,
    entries: params.entries,
    name: packageName,
    packageRoot,
    version: params.version,
  });
  if (params.withManifest === false) {
    writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: packageName,
          version: params.version ?? "0.1.0",
          ...(params.repository ? { repository: params.repository } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else if (params.repository) {
    const packageJson = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    packageJson.repository = params.repository;
    writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
  }
  if (params.includeDependency) {
    const dependencyRoot = path.join(params.cwd, "node_modules", "left-pad");
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(
      path.join(dependencyRoot, "package.json"),
      `${JSON.stringify({ name: "left-pad", version: "1.0.0" })}\n`,
    );
    writeFileSync(
      path.join(dependencyRoot, "index.js"),
      "export default 'dep';\n",
    );
    const binRoot = path.join(params.cwd, "node_modules", ".bin");
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(path.join(binRoot, "left-pad"), "ignored\n");
    const nestedDependencyRoot = path.join(
      packageRoot,
      "node_modules",
      "nested-dep",
    );
    mkdirSync(nestedDependencyRoot, { recursive: true });
    writeFileSync(
      path.join(nestedDependencyRoot, "package.json"),
      `${JSON.stringify({ name: "nested-dep", version: "1.0.0" })}\n`,
    );
    writeFileSync(
      path.join(nestedDependencyRoot, "index.js"),
      "export default 'nested';\n",
    );
  }
}

function writeCompatibilityGitPackage(params: {
  dependencies?: Record<string, string>;
  packageRoot: string;
  version?: string;
}): void {
  mkdirSync(path.join(params.packageRoot, "src"), { recursive: true });
  writeFileSync(path.join(params.packageRoot, "src", "mod.ts"), "export {};\n");
  writeFileSync(
    path.join(params.packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "git-mod",
        version: params.version ?? "0.1.0",
        ...(params.dependencies ? { dependencies: params.dependencies } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

function createChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function readRegistry(modsRoot: string): {
  packages: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path.join(modsRoot, "packages.json"), "utf8"));
}

afterEach(() => {
  __testOverrideNpmManagedModPackageInstaller({});
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("local managed mod package installer", () => {
  test("parses npm install specs", () => {
    expect(
      parseNpmManagedModPackageInstallSpecifier("npm:@caren/my-mod"),
    ).toEqual({
      installSpec: "@caren/my-mod",
      packageName: "@caren/my-mod",
      source: "npm:@caren/my-mod",
    });
    expect(
      parseNpmManagedModPackageInstallSpecifier("npm:@caren/my-mod@0.2.0"),
    ).toEqual({
      installSpec: "@caren/my-mod@0.2.0",
      packageName: "@caren/my-mod",
      source: "npm:@caren/my-mod",
      version: "0.2.0",
    });
    expect(parseNpmManagedModPackageInstallSpecifier("npm:my-mod")).toEqual({
      installSpec: "my-mod",
      packageName: "my-mod",
      source: "npm:my-mod",
    });
    expect(
      parseNpmManagedModPackageInstallSpecifier("npm:my-mod@0.2.0"),
    ).toEqual({
      installSpec: "my-mod@0.2.0",
      packageName: "my-mod",
      source: "npm:my-mod",
      version: "0.2.0",
    });
    expect(() =>
      parseNpmManagedModPackageInstallSpecifier("npm:@caren"),
    ).toThrow("Invalid npm mod package specifier");
    expect(() =>
      parseNpmManagedModPackageInstallSpecifier("npm:alias@npm:other"),
    ).toThrow("Invalid npm package version or tag");
    expect(() =>
      parseNpmManagedModPackageInstallSpecifier("npm:my-mod@file:.."),
    ).toThrow("Invalid npm package version or tag");
    expect(() =>
      parseNpmManagedModPackageInstallSpecifier("npm:my-mod@../local"),
    ).toThrow();
    expect(() =>
      parseNpmManagedModPackageInstallSpecifier("npm:my-mod@foo\\bar"),
    ).toThrow("Invalid npm package version or tag");
  });

  test("parses GitHub package install specs", () => {
    expect(
      parseGitManagedModPackageInstallSpecifier(
        "https://github.com/Caren/My-Mod.git@v1",
      ),
    ).toEqual({
      cloneUrl: "https://github.com/caren/my-mod.git",
      owner: "caren",
      ref: "v1",
      repo: "my-mod",
      repository: "https://github.com/caren/my-mod",
      source: "git:https://github.com/caren/my-mod",
    });
    expect(
      parseGitManagedModPackageInstallSpecifier("git:github.com/caren/my-mod"),
    ).toMatchObject({
      cloneUrl: "https://github.com/caren/my-mod.git",
      source: "git:https://github.com/caren/my-mod",
    });
    expect(
      parseGitManagedModPackageInstallSpecifier(
        "ssh://git@github.com/caren/my-mod.git@abc123",
      ),
    ).toMatchObject({
      ref: "abc123",
      source: "git:https://github.com/caren/my-mod",
    });
    expect(
      parseGitManagedModPackageInstallSpecifier(
        "https://github.com/caren/my-mod/tree/main",
      ),
    ).toBeNull();
    expect(
      parseGitManagedModPackageInstallSpecifier(
        "https://gitlab.com/caren/my-mod",
      ),
    ).toBeNull();
  });

  test("rejects git refs that start with a dash (option injection)", () => {
    expect(() =>
      parseGitManagedModPackageInstallSpecifier(
        "https://github.com/caren/my-mod@--orphan=evil",
      ),
    ).toThrow("Invalid git ref");
    expect(() =>
      parseGitManagedModPackageInstallSpecifier(
        "https://github.com/caren/my-mod@-f",
      ),
    ).toThrow("Invalid git ref");
    expect(() =>
      parseGitManagedModPackageInstallSpecifier(
        "git:github.com/caren/my-mod@-B",
      ),
    ).toThrow("Invalid git ref");
    expect(() =>
      parseGitManagedModPackageInstallSpecifier(
        "ssh://git@github.com/caren/my-mod.git@--upload-pack=evil",
      ),
    ).toThrow("Invalid git ref");
  });

  test("accepts valid git refs with dots and dashes", () => {
    expect(
      parseGitManagedModPackageInstallSpecifier(
        "https://github.com/caren/my-mod@v1.2.3",
      ),
    ).toMatchObject({ ref: "v1.2.3" });
    expect(
      parseGitManagedModPackageInstallSpecifier(
        "git:github.com/caren/my-mod@release-1.0",
      ),
    ).toMatchObject({ ref: "release-1.0" });
    expect(
      parseGitManagedModPackageInstallSpecifier(
        "ssh://git@github.com/caren/my-mod.git@abc123",
      ),
    ).toMatchObject({ ref: "abc123" });
  });

  test("installs a local package into the managed package directory", () => {
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({
      capabilities: ["commands"],
      packageRoot,
    });
    mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    writeFileSync(path.join(packageRoot, ".git", "config"), "ignored\n");
    mkdirSync(path.join(packageRoot, "node_modules", "dep"), {
      recursive: true,
    });
    writeFileSync(
      path.join(packageRoot, "node_modules", "dep", "index.js"),
      "ignored\n",
    );

    const result = installLocalManagedModPackage({
      modsRoot,
      packageDirectory: packageRoot,
    });

    expect(result).toMatchObject({
      capabilities: ["commands"],
      entries: ["mods/index.ts"],
      rootRelativePath: "packages/npm/@caren/my-mod",
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });
    expect(existsSync(path.join(result.root, "mods", "index.ts"))).toBe(true);
    expect(existsSync(path.join(result.root, ".git"))).toBe(false);
    expect(existsSync(path.join(result.root, "node_modules"))).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "npm:@caren/my-mod",
        version: "0.1.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/index.ts"],
      },
    ]);
  });

  test("first install removes copied package root when registry write fails", () => {
    if (process.platform === "win32") return;
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeFileSync(
      path.join(modsRoot, "packages.json"),
      '{\n  "packages": []\n}\n',
    );
    writeLocalPackage({ packageRoot });
    const registryPath = path.join(modsRoot, "packages.json");
    chmodSync(registryPath, 0o444);

    try {
      expect(() =>
        installLocalManagedModPackage({
          modsRoot,
          packageDirectory: packageRoot,
        }),
      ).toThrow();
    } finally {
      chmodSync(registryPath, 0o644);
    }
    expect(
      existsSync(path.join(modsRoot, "packages", "npm", "@caren", "my-mod")),
    ).toBe(false);
    expect(readFileSync(registryPath, "utf8")).toBe('{\n  "packages": []\n}\n');
  });

  test("reinstall replaces the package root and updates the same registry entry", () => {
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({ packageRoot });
    const first = installLocalManagedModPackage({
      modsRoot,
      packageDirectory: packageRoot,
    });
    writeFileSync(path.join(first.root, "stale.ts"), "stale\n");
    rmSync(path.join(packageRoot, "mods", "index.ts"));

    writeLocalPackage({
      entries: ["mods/next.ts"],
      packageRoot,
      version: "0.2.0",
    });
    const second = installLocalManagedModPackage({
      modsRoot,
      packageDirectory: packageRoot,
    });

    expect(second.root).toBe(first.root);
    expect(existsSync(path.join(second.root, "mods", "next.ts"))).toBe(true);
    expect(existsSync(path.join(second.root, "mods", "index.ts"))).toBe(false);
    expect(existsSync(path.join(second.root, "stale.ts"))).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "npm:@caren/my-mod",
        version: "0.2.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/next.ts"],
      },
    ]);
  });

  test("reinstall restores existing package root when registry write fails", () => {
    if (process.platform === "win32") return;
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({ packageRoot });
    const first = installLocalManagedModPackage({
      modsRoot,
      packageDirectory: packageRoot,
    });
    rmSync(path.join(packageRoot, "mods", "index.ts"));
    writeLocalPackage({
      entries: ["mods/next.ts"],
      packageRoot,
      version: "0.2.0",
    });
    const registryPath = path.join(modsRoot, "packages.json");
    chmodSync(registryPath, 0o444);

    try {
      expect(() =>
        installLocalManagedModPackage({
          modsRoot,
          packageDirectory: packageRoot,
        }),
      ).toThrow();
    } finally {
      chmodSync(registryPath, 0o644);
    }
    expect(existsSync(path.join(first.root, "mods", "index.ts"))).toBe(true);
    expect(existsSync(path.join(first.root, "mods", "next.ts"))).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "npm:@caren/my-mod",
        version: "0.1.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/index.ts"],
      },
    ]);
  });

  test("missing letta manifest fails before writing", () => {
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "@caren/my-mod", version: "0.1.0" })}\n`,
    );

    expect(() =>
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      }),
    ).toThrow("Package does not include a package.json#letta manifest");
    expect(existsSync(path.join(modsRoot, "packages"))).toBe(false);
    expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
  });

  test("missing declared mod file fails before writing", () => {
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({
      entries: ["mods/missing.ts"],
      packageRoot,
      writeEntries: false,
    });

    expect(() =>
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      }),
    ).toThrow("Package mod entry does not exist: mods/missing.ts");
    expect(existsSync(path.join(modsRoot, "packages"))).toBe(false);
    expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
  });

  test("malformed registry fails before copying", () => {
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeFileSync(path.join(modsRoot, "packages.json"), "{\n");
    writeLocalPackage({ packageRoot });

    expect(() =>
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      }),
    ).toThrow();
    expect(readFileSync(path.join(modsRoot, "packages.json"), "utf8")).toBe(
      "{\n",
    );
    expect(
      existsSync(path.join(modsRoot, "packages", "npm", "@caren", "my-mod")),
    ).toBe(false);
  });

  test("source inside managed packages directory is rejected", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const packageRoot = path.join(
      modsRoot,
      "packages",
      "npm",
      "@caren",
      "my-mod",
    );
    writeLocalPackage({ packageRoot });

    expect(() =>
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      }),
    ).toThrow(
      "Cannot install a package from inside the managed packages directory",
    );
  });

  test("destination inside source package directory is rejected", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({ packageRoot: modsRoot });

    expect(() =>
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: modsRoot,
      }),
    ).toThrow("Cannot install a package into one of its own subdirectories");
  });

  test("symlinks in source packages are rejected", () => {
    if (process.platform === "win32") return;
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({ packageRoot });
    symlinkSync(
      path.join(packageRoot, "mods", "index.ts"),
      path.join(packageRoot, "linked.ts"),
    );

    expect(() =>
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      }),
    ).toThrow("Package contains unsupported symlink");
    expect(
      existsSync(path.join(modsRoot, "packages", "npm", "@caren", "my-mod")),
    ).toBe(false);
  });

  test("installs an npm package with safe npm flags", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const spawnCalls: Array<{ args: string[]; cmd: string; cwd?: string }> = [];
    __testOverrideNpmManagedModPackageInstaller({
      platform: "linux",
      spawnImpl: (cmd, args, options) => {
        spawnCalls.push({ args, cmd, cwd: options.cwd?.toString() });
        if (!options.cwd) throw new Error("expected cwd");
        writeInstalledNpmPackage({
          capabilities: ["commands"],
          cwd: options.cwd.toString(),
          includeDependency: true,
          repository: { url: "https://github.com/caren/my-mod.git" },
          version: "0.2.0",
        });
        const child = createChildProcess();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });

    const result = await installNpmManagedModPackage({
      modsRoot,
      specifier: "npm:@caren/my-mod",
    });

    expect(spawnCalls).toEqual([
      {
        cmd: "npm",
        args: [
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          "--no-save",
          "@caren/my-mod",
        ],
        cwd: expect.any(String),
      },
    ]);
    expect(result).toMatchObject({
      capabilities: ["commands"],
      repository: "https://github.com/caren/my-mod.git",
      source: "npm:@caren/my-mod",
      version: "0.2.0",
    });
    expect(existsSync(path.join(result.root, "mods", "index.ts"))).toBe(true);
    expect(
      existsSync(
        path.join(result.root, "node_modules", "left-pad", "index.js"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(result.root, "node_modules", "nested-dep", "index.js"),
      ),
    ).toBe(true);
    expect(existsSync(path.join(result.root, "node_modules", ".bin"))).toBe(
      false,
    );
    expect(
      existsSync(path.join(result.root, "node_modules", "@caren", "my-mod")),
    ).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "npm:@caren/my-mod",
        version: "0.2.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/index.ts"],
      },
    ]);
  });

  test("installs unscoped npm packages and uses Windows npm shim", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const spawnCalls: Array<{ args: string[]; cmd: string }> = [];
    __testOverrideNpmManagedModPackageInstaller({
      platform: "win32",
      spawnImpl: (cmd, args, options) => {
        spawnCalls.push({ args, cmd });
        if (!options.cwd) throw new Error("expected cwd");
        writeInstalledNpmPackage({
          cwd: options.cwd.toString(),
          name: "my-mod",
        });
        const child = createChildProcess();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });

    const result = await installNpmManagedModPackage({
      modsRoot,
      specifier: "npm:my-mod@0.1.0",
    });

    expect(spawnCalls).toEqual([
      {
        cmd: "npm.cmd",
        args: [
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          "--no-save",
          "--no-bin-links",
          "my-mod@0.1.0",
        ],
      },
    ]);
    expect(result).toMatchObject({
      rootRelativePath: "packages/npm/my-mod",
      source: "npm:my-mod",
    });
  });

  test("updates an installed npm package and reports old and new versions", async () => {
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({ packageRoot });
    const first = installLocalManagedModPackage({
      modsRoot,
      packageDirectory: packageRoot,
    });
    writeFileSync(path.join(first.root, "stale.ts"), "stale\n");
    const spawnCalls: Array<{ args: string[]; cmd: string }> = [];
    __testOverrideNpmManagedModPackageInstaller({
      platform: "linux",
      spawnImpl: (cmd, args, options) => {
        spawnCalls.push({ args, cmd });
        if (!options.cwd) throw new Error("expected cwd");
        writeInstalledNpmPackage({
          cwd: options.cwd.toString(),
          entries: ["mods/next.ts"],
          version: "0.2.0",
        });
        const child = createChildProcess();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });

    const result = await updateNpmManagedModPackage({
      modsRoot,
      specifier: "npm:@caren/my-mod@0.2.0",
    });

    expect(spawnCalls).toEqual([
      {
        cmd: "npm",
        args: [
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          "--no-save",
          "@caren/my-mod@0.2.0",
        ],
      },
    ]);
    expect(result).toMatchObject({
      enabled: true,
      previousVersion: "0.1.0",
      source: "npm:@caren/my-mod",
      version: "0.2.0",
    });
    expect(existsSync(path.join(result.root, "mods", "next.ts"))).toBe(true);
    expect(existsSync(path.join(result.root, "mods", "index.ts"))).toBe(false);
    expect(existsSync(path.join(result.root, "stale.ts"))).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "npm:@caren/my-mod",
        version: "0.2.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/next.ts"],
      },
    ]);
  });

  test("update preserves disabled package state", async () => {
    const root = createTempDir();
    const packageRoot = path.join(root, "source");
    const modsRoot = path.join(root, "mods");
    writeLocalPackage({ packageRoot });
    installLocalManagedModPackage({
      modsRoot,
      packageDirectory: packageRoot,
    });
    const registry = readRegistry(modsRoot);
    registry.packages[0] = {
      ...registry.packages[0],
      enabled: false,
    };
    writeFileSync(
      path.join(modsRoot, "packages.json"),
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    __testOverrideNpmManagedModPackageInstaller({
      spawnImpl: (_cmd, _args, options) => {
        if (!options.cwd) throw new Error("expected cwd");
        writeInstalledNpmPackage({
          cwd: options.cwd.toString(),
          version: "0.2.0",
        });
        const child = createChildProcess();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });

    const result = await updateNpmManagedModPackage({
      modsRoot,
      specifier: "npm:@caren/my-mod",
    });

    expect(result.enabled).toBe(false);
    expect(readRegistry(modsRoot).packages[0]?.enabled).toBe(false);
    expect(readRegistry(modsRoot).packages[0]?.version).toBe("0.2.0");
  });

  test("update requires an installed package", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");

    await expect(
      updateNpmManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).rejects.toThrow("No managed mod packages are installed.");
  });

  test("updates an installed git package and reports old and new versions", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    let cloneCount = 0;
    __testOverrideNpmManagedModPackageInstaller({
      gitSpawnImpl: (_cmd, args, _options) => {
        if (args[0] === "clone") {
          cloneCount++;
          writeLocalPackage({
            capabilities: ["commands"],
            entries: cloneCount === 1 ? ["mods/index.ts"] : ["mods/next.ts"],
            name: "git-mod",
            packageRoot: String(args.at(-1)),
            version: cloneCount === 1 ? "0.1.0" : "0.2.0",
          });
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") {
            child.stdout?.emit(
              "data",
              cloneCount === 1 ? "abc123\n" : "def456\n",
            );
          }
          child.emit("exit", 0);
        });
        return child;
      },
    });

    const first = await installGitManagedModPackage({
      modsRoot,
      specifier: "https://github.com/caren/git-mod",
    });
    writeFileSync(path.join(first.root, "stale.ts"), "stale\n");

    const result = await updateGitManagedModPackage({
      modsRoot,
      specifier: "https://github.com/caren/git-mod",
    });

    expect(result).toMatchObject({
      enabled: true,
      previousVersion: "0.1.0",
      source: "git:https://github.com/caren/git-mod",
      version: "0.2.0",
    });
    expect(existsSync(path.join(result.root, "mods", "next.ts"))).toBe(true);
    expect(existsSync(path.join(result.root, "mods", "index.ts"))).toBe(false);
    expect(existsSync(path.join(result.root, "stale.ts"))).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "git:https://github.com/caren/git-mod",
        version: "0.2.0",
        enabled: true,
        root: "packages/git/github.com/caren/git-mod",
        entries: ["mods/next.ts"],
      },
    ]);
  });

  test("update git package preserves disabled state", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    let cloneCount = 0;
    __testOverrideNpmManagedModPackageInstaller({
      gitSpawnImpl: (_cmd, args) => {
        if (args[0] === "clone") {
          cloneCount++;
          writeLocalPackage({
            name: "git-mod",
            packageRoot: String(args.at(-1)),
            version: cloneCount === 1 ? "0.1.0" : "0.2.0",
          });
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") child.stdout?.emit("data", "abc123\n");
          child.emit("exit", 0);
        });
        return child;
      },
    });

    await installGitManagedModPackage({
      modsRoot,
      specifier: "https://github.com/caren/git-mod",
    });
    const registry = readRegistry(modsRoot);
    registry.packages[0] = { ...registry.packages[0], enabled: false };
    writeFileSync(
      path.join(modsRoot, "packages.json"),
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const result = await updateGitManagedModPackage({
      modsRoot,
      specifier: "https://github.com/caren/git-mod",
    });

    expect(result.enabled).toBe(false);
    expect(readRegistry(modsRoot).packages[0]?.enabled).toBe(false);
    expect(readRegistry(modsRoot).packages[0]?.version).toBe("0.2.0");
  });

  test("git update requires an installed package", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");

    await expect(
      updateGitManagedModPackage({
        modsRoot,
        specifier: "https://github.com/caren/git-mod",
      }),
    ).rejects.toThrow("No managed mod packages are installed.");
  });

  test("git update invalid specifier fails", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");

    await expect(
      updateGitManagedModPackage({
        modsRoot,
        specifier: "npm:invalid",
      }),
    ).rejects.toThrow("Invalid git mod package specifier");
  });

  test("npm install failure does not write registry", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    __testOverrideNpmManagedModPackageInstaller({
      spawnImpl: () => {
        const child = createChildProcess();
        queueMicrotask(() => {
          child.stderr?.emit("data", "not found");
          child.emit("exit", 1);
        });
        return child;
      },
    });

    await expect(
      installNpmManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/missing-mod",
      }),
    ).rejects.toThrow("npm install failed with code 1: not found");
    expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
  });

  test("npm packages without letta manifests fail without writing", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    __testOverrideNpmManagedModPackageInstaller({
      spawnImpl: (_cmd, _args, options) => {
        if (!options.cwd) throw new Error("expected cwd");
        writeInstalledNpmPackage({
          cwd: options.cwd.toString(),
          withManifest: false,
        });
        const child = createChildProcess();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });

    await expect(
      installNpmManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).rejects.toThrow("Package does not include a package.json#letta manifest");
    expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
    expect(
      existsSync(path.join(modsRoot, "packages", "npm", "@caren", "my-mod")),
    ).toBe(false);
  });

  test("installs a GitHub package with a manifest", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
    __testOverrideNpmManagedModPackageInstaller({
      gitSpawnImpl: (_cmd, args, options) => {
        gitCalls.push({ args, cwd: options.cwd?.toString() });
        if (args[0] === "clone") {
          const packageRoot = String(args.at(-1));
          writeLocalPackage({
            capabilities: ["commands"],
            name: "git-mod",
            packageRoot,
          });
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") {
            child.stdout?.emit("data", "abc123\n");
          }
          child.emit("exit", 0);
        });
        return child;
      },
    });

    const result = await installGitManagedModPackage({
      modsRoot,
      specifier: "https://github.com/caren/git-mod",
    });

    expect(gitCalls.map((call) => call.args)).toEqual([
      [
        "clone",
        "--depth",
        "1",
        "https://github.com/caren/git-mod.git",
        expect.any(String),
      ],
      ["rev-parse", "--short", "HEAD"],
    ]);
    expect(result).toMatchObject({
      capabilities: ["commands"],
      repository: "https://github.com/caren/git-mod",
      rootRelativePath: "packages/git/github.com/caren/git-mod",
      source: "git:https://github.com/caren/git-mod",
      version: "0.1.0",
    });
    expect(existsSync(path.join(result.root, "mods", "index.ts"))).toBe(true);
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "git:https://github.com/caren/git-mod",
        version: "0.1.0",
        enabled: true,
        root: "packages/git/github.com/caren/git-mod",
        entries: ["mods/index.ts"],
      },
    ]);
  });

  test("installs a compatibility GitHub package from src/mod.ts", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    __testOverrideNpmManagedModPackageInstaller({
      gitSpawnImpl: (_cmd, args) => {
        if (args[0] === "clone") {
          writeCompatibilityGitPackage({ packageRoot: String(args.at(-1)) });
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") child.stdout?.emit("data", "def456\n");
          child.emit("exit", 0);
        });
        return child;
      },
    });

    const result = await installGitManagedModPackage({
      modsRoot,
      specifier: "git:github.com/caren/compat-mod",
    });

    expect(result).toMatchObject({
      capabilities: [],
      entries: ["src/mod.ts"],
      source: "git:https://github.com/caren/compat-mod",
      version: "0.1.0",
    });
    expect(
      JSON.parse(readFileSync(path.join(result.root, "package.json"), "utf8"))
        .letta,
    ).toEqual({
      manifestVersion: 1,
      mods: ["src/mod.ts"],
    });
    expect(readRegistry(modsRoot).packages[0]).toMatchObject({
      root: "packages/git/github.com/caren/compat-mod",
      entries: ["src/mod.ts"],
    });
  });

  test("GitHub package install runs safe dependency install", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const npmCalls: Array<{ args: string[]; cmd: string; cwd?: string }> = [];
    __testOverrideNpmManagedModPackageInstaller({
      platform: "linux",
      gitSpawnImpl: (_cmd, args) => {
        if (args[0] === "clone") {
          writeCompatibilityGitPackage({
            dependencies: { "left-pad": "1.0.0" },
            packageRoot: String(args.at(-1)),
          });
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") child.stdout?.emit("data", "abc123\n");
          child.emit("exit", 0);
        });
        return child;
      },
      spawnImpl: (cmd, args, options) => {
        npmCalls.push({ args, cmd, cwd: options.cwd?.toString() });
        if (!options.cwd) throw new Error("expected cwd");
        const dependencyRoot = path.join(
          options.cwd.toString(),
          "node_modules",
          "left-pad",
        );
        mkdirSync(dependencyRoot, { recursive: true });
        writeFileSync(path.join(dependencyRoot, "index.js"), "export {};\n");
        const child = createChildProcess();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });

    const result = await installGitManagedModPackage({
      modsRoot,
      specifier: "https://github.com/caren/deps-mod@v1",
    });

    expect(npmCalls).toEqual([
      {
        cmd: "npm",
        args: [
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          "--no-save",
        ],
        cwd: expect.any(String),
      },
    ]);
    expect(
      existsSync(
        path.join(result.root, "node_modules", "left-pad", "index.js"),
      ),
    ).toBe(true);
  });

  test("GitHub packages without a manifest or conventional entry fail without writing", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    __testOverrideNpmManagedModPackageInstaller({
      gitSpawnImpl: (_cmd, args) => {
        if (args[0] === "clone") {
          const packageRoot = String(args.at(-1));
          mkdirSync(packageRoot, { recursive: true });
          writeFileSync(
            path.join(packageRoot, "package.json"),
            `${JSON.stringify({ name: "not-a-mod", version: "0.1.0" })}\n`,
          );
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") child.stdout?.emit("data", "abc123\n");
          child.emit("exit", 0);
        });
        return child;
      },
    });

    await expect(
      installGitManagedModPackage({
        modsRoot,
        specifier: "https://github.com/caren/not-a-mod",
      }),
    ).rejects.toThrow("GitHub repo is not an installable Letta mod package");
    expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
    expect(existsSync(path.join(modsRoot, "packages"))).toBe(false);
  });

  test("git checkout uses -- separator to prevent option injection", async () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
    __testOverrideNpmManagedModPackageInstaller({
      gitSpawnImpl: (_cmd, args, options) => {
        gitCalls.push({ args, cwd: options.cwd?.toString() });
        if (args[0] === "clone") {
          writeLocalPackage({
            capabilities: ["commands"],
            name: "git-mod",
            packageRoot: String(args.at(-1)),
          });
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") {
            child.stdout?.emit("data", "abc123\n");
          }
          child.emit("exit", 0);
        });
        return child;
      },
    });

    await installGitManagedModPackage({
      modsRoot,
      specifier: "https://github.com/caren/git-mod@v1.2.3",
    });

    expect(gitCalls.map((call) => call.args)).toEqual([
      ["clone", "https://github.com/caren/git-mod.git", expect.any(String)],
      ["checkout", "--", "v1.2.3"],
      ["rev-parse", "--short", "HEAD"],
    ]);
  });
});
