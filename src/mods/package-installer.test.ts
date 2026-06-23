import { afterEach, describe, expect, test } from "bun:test";
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
import { installLocalManagedModPackage } from "@/mods/package-installer";

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

function readRegistry(modsRoot: string): {
  packages: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path.join(modsRoot, "packages.json"), "utf8"));
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("local managed mod package installer", () => {
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
});
