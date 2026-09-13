import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getManagedModPackageRootRelativePathForSource,
  listManagedModPackages,
  removeManagedModPackage,
  setManagedModPackageEnabled,
  upsertManagedModPackage,
} from "@/mods/package-registry";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "letta-package-registry-"));
  tempRoots.push(dir);
  return dir;
}

function writePackage(params: {
  capabilities?: string[];
  enabled: boolean;
  modsRoot: string;
  root: string;
  source: string;
  version: string;
}): string {
  const packageRoot = path.join(params.modsRoot, ...params.root.split("/"));
  mkdirSync(path.join(packageRoot, "mods"), { recursive: true });
  writeFileSync(path.join(packageRoot, "mods", "index.ts"), "export {};\n");
  writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        letta: {
          manifestVersion: 1,
          mods: ["mods/index.ts"],
          ...(params.capabilities ? { capabilities: params.capabilities } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  return packageRoot;
}

function writeRegistry(
  modsRoot: string,
  packages: Array<{
    enabled: boolean;
    root: string;
    source: string;
    version: string;
  }>,
): void {
  writeFileSync(
    path.join(modsRoot, "packages.json"),
    `${JSON.stringify(
      {
        packages: packages.map((pkg) => ({
          ...pkg,
          entries: ["mods/index.ts"],
        })),
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

describe("managed mod package registry", () => {
  test("derives npm package roots from valid package sources", () => {
    expect(getManagedModPackageRootRelativePathForSource("npm:my-mod")).toBe(
      "packages/npm/my-mod",
    );
    expect(
      getManagedModPackageRootRelativePathForSource("npm:@caren/my-mod"),
    ).toBe("packages/npm/@caren/my-mod");
    expect(
      getManagedModPackageRootRelativePathForSource(
        "git:https://github.com/caren/my-mod",
      ),
    ).toBe("packages/git/github.com/caren/my-mod");

    for (const source of [
      "npm:@caren",
      "npm:my/mod",
      "npm:../my-mod",
      "npm:.",
      "npm:",
      "git:https://github.com/caren",
      "git:https://gitlab.com/caren/my-mod",
      "path:my-mod",
    ]) {
      expect(getManagedModPackageRootRelativePathForSource(source)).toBeNull();
    }
  });

  test("upsert derives root and creates registry", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");

    const result = upsertManagedModPackage({
      entries: ["mods/index.ts"],
      modsRoot,
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });

    expect(result).toMatchObject({ replaced: false, removedDuplicates: 0 });
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

  test("upsert replaces same source in place and removes duplicates", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/first",
        source: "npm:first",
        version: "0.1.0",
      },
      {
        enabled: false,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
      {
        enabled: true,
        root: "packages/npm/last",
        source: "npm:last",
        version: "0.1.0",
      },
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.0.1",
      },
    ]);

    const result = upsertManagedModPackage({
      enabled: true,
      entries: ["mods/next.ts"],
      modsRoot,
      source: "npm:@caren/my-mod",
      version: "0.2.0",
    });

    expect(result).toMatchObject({ replaced: true, removedDuplicates: 1 });
    expect(readRegistry(modsRoot).packages).toEqual([
      expect.objectContaining({ source: "npm:first" }),
      {
        source: "npm:@caren/my-mod",
        version: "0.2.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/next.ts"],
      },
      expect.objectContaining({ source: "npm:last" }),
    ]);
  });

  test("lists enabled and disabled packages with manifest capabilities", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writePackage({
      capabilities: ["commands"],
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/enabled-mod",
      source: "npm:@caren/enabled-mod",
      version: "0.1.0",
    });
    writePackage({
      capabilities: ["tools"],
      enabled: false,
      modsRoot,
      root: "packages/npm/@caren/disabled-mod",
      source: "npm:@caren/disabled-mod",
      version: "0.2.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren/enabled-mod",
        source: "npm:@caren/enabled-mod",
        version: "0.1.0",
      },
      {
        enabled: false,
        root: "packages/npm/@caren/disabled-mod",
        source: "npm:@caren/disabled-mod",
        version: "0.2.0",
      },
    ]);

    expect(listManagedModPackages(modsRoot)).toMatchObject({
      diagnostics: [],
      packages: [
        {
          capabilities: ["commands"],
          enabled: true,
          source: "npm:@caren/enabled-mod",
          version: "0.1.0",
        },
        {
          capabilities: ["tools"],
          enabled: false,
          source: "npm:@caren/disabled-mod",
          version: "0.2.0",
        },
      ],
      registryExists: true,
    });
  });

  test("enables and disables packages by source", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writePackage({
      enabled: false,
      modsRoot,
      root: "packages/npm/@caren/my-mod",
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: false,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    expect(
      setManagedModPackageEnabled({
        enabled: true,
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }).package,
    ).toMatchObject({ enabled: true, source: "npm:@caren/my-mod" });
    expect(readRegistry(modsRoot).packages[0]?.enabled).toBe(true);

    setManagedModPackageEnabled({
      enabled: false,
      modsRoot,
      specifier: "npm:@caren/my-mod@0.1.0",
    });
    expect(readRegistry(modsRoot).packages[0]?.enabled).toBe(false);
  });

  test("remove deletes registry entry and package root", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    const packageRoot = writePackage({
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/my-mod",
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    const result = removeManagedModPackage({
      modsRoot,
      specifier: "npm:@caren/my-mod",
    });

    expect(result.removedRoot).toBe(packageRoot);
    expect(existsSync(packageRoot)).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([]);
  });

  test("remove refuses roots outside the expected package path", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    const modFilePath = path.join(modsRoot, "mod-file.ts");
    writeFileSync(modFilePath, "export {};\n");
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "mod-file.ts",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    expect(() =>
      removeManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow("Refusing to remove npm:@caren/my-mod@0.1.0");
    expect(existsSync(modFilePath)).toBe(true);
    expect(readRegistry(modsRoot).packages).toHaveLength(1);
  });

  test("remove refuses broad package parent roots", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(path.join(modsRoot, "packages", "npm", "@caren"), {
      recursive: true,
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    expect(() =>
      removeManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow("does not match expected package root");
    expect(existsSync(path.join(modsRoot, "packages", "npm"))).toBe(true);
    expect(readRegistry(modsRoot).packages).toHaveLength(1);
  });

  test("remove refuses scoped namespace package sources", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const scopedRoot = path.join(modsRoot, "packages", "npm", "@caren");
    mkdirSync(scopedRoot, { recursive: true });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren",
        source: "npm:@caren",
        version: "0.1.0",
      },
    ]);

    expect(() =>
      removeManagedModPackage({
        modsRoot,
        specifier: "npm:@caren@0.1.0",
      }),
    ).toThrow("does not match expected package root");
    expect(existsSync(scopedRoot)).toBe(true);
    expect(readRegistry(modsRoot).packages).toHaveLength(1);
  });

  test("source-only spec errors when multiple versions match", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writePackage({
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/my-mod-1",
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });
    writePackage({
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/my-mod-2",
      source: "npm:@caren/my-mod",
      version: "0.2.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod-1",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod-2",
        source: "npm:@caren/my-mod",
        version: "0.2.0",
      },
    ]);

    expect(() =>
      setManagedModPackageEnabled({
        enabled: false,
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow("Multiple versions match npm:@caren/my-mod");

    setManagedModPackageEnabled({
      enabled: false,
      modsRoot,
      specifier: "npm:@caren/my-mod@0.2.0",
    });
    expect(readRegistry(modsRoot).packages.map((pkg) => pkg.enabled)).toEqual([
      true,
      false,
    ]);
  });

  test("malformed registry errors without writing", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    const registryPath = path.join(modsRoot, "packages.json");
    writeFileSync(registryPath, "{\n");

    expect(() =>
      setManagedModPackageEnabled({
        enabled: false,
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow();
    expect(readFileSync(registryPath, "utf8")).toBe("{\n");
  });
});
