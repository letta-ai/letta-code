import { afterEach, describe, expect, test } from "bun:test";
import {
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
import { readLettaPackageManifest } from "@/mods/package-manifest";
import { scaffoldLocalModPackage } from "@/mods/package-scaffolder";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "letta-package-scaffold-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("local mod package scaffolder", () => {
  test("creates a package scaffold from a mod file", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "hello.ts");
    const outputDirectory = path.join(root, "hello-package");
    writeFileSync(
      sourceFile,
      `export default function activate(letta) {
        letta.commands.register({ id: "hello", description: "Hello", run() {} });
      }\n`,
    );

    const result = scaffoldLocalModPackage({
      outputDirectory,
      packageName: "@caren/hello-mod",
      sourceFile,
    });

    expect(result).toMatchObject({
      installCommand: `letta install ${outputDirectory}`,
      manifestEntry: "mods/hello.ts",
      modGuidePath: path.join(outputDirectory, "MOD.md"),
      outputDirectory,
      packageName: "@caren/hello-mod",
      sourceFile,
      targetModPath: path.join(outputDirectory, "mods", "hello.ts"),
    });
    expect(readFileSync(result.targetModPath, "utf8")).toContain(
      "letta.commands.register",
    );
    expect(JSON.parse(readFileSync(result.packageJsonPath, "utf8"))).toEqual({
      name: "@caren/hello-mod",
      version: "0.1.0",
      type: "module",
      keywords: ["letta-package", "letta-mod"],
      files: ["README.md", "MOD.md", "mods"],
      letta: {
        manifestVersion: 1,
        mods: ["mods/hello.ts"],
      },
    });
    expect(readLettaPackageManifest(result.packageJsonPath)).toMatchObject({
      manifest: {
        mods: ["mods/hello.ts"],
      },
      ok: true,
    });
    expect(readFileSync(result.readmePath, "utf8")).toContain(
      "letta install .",
    );
    expect(readFileSync(result.modGuidePath, "utf8")).toContain(
      "TODO: Describe what this mod does.",
    );
    expect(readFileSync(result.modGuidePath, "utf8")).toContain(
      "`mods/hello.ts`",
    );
  });

  test("default output directory is derived from package name", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "statusline.tsx");
    writeFileSync(sourceFile, "export default () => {};\n");

    const result = scaffoldLocalModPackage({
      packageName: "@caren/statusline-mod",
      sourceFile,
    });

    expect(result.outputDirectory).toBe(path.join(root, "statusline-mod"));
    expect(existsSync(path.join(result.outputDirectory, "package.json"))).toBe(
      true,
    );
    expect(existsSync(path.join(result.outputDirectory, "MOD.md"))).toBe(true);
  });

  test("created package can be installed by local package installer", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "tool.mjs");
    const outputDirectory = path.join(root, "tool-package");
    const modsRoot = path.join(root, "mods");
    writeFileSync(sourceFile, "export default () => {};\n");

    scaffoldLocalModPackage({
      outputDirectory,
      packageName: "tool-package",
      sourceFile,
    });
    const installResult = installLocalManagedModPackage({
      modsRoot,
      packageDirectory: outputDirectory,
    });

    expect(installResult).toMatchObject({
      entries: ["mods/tool.mjs"],
      source: "npm:tool-package",
      version: "0.1.0",
    });
  });

  test("rejects invalid package names", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "hello.ts");
    writeFileSync(sourceFile, "export default () => {};\n");

    expect(() =>
      scaffoldLocalModPackage({
        packageName: "@caren",
        sourceFile,
      }),
    ).toThrow("Package name must be a valid npm package name");
    expect(() =>
      scaffoldLocalModPackage({
        packageName: "hello/world/extra",
        sourceFile,
      }),
    ).toThrow("Package name must be a valid npm package name");
  });

  test("rejects unsupported source file extensions", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "hello.txt");
    writeFileSync(sourceFile, "not a mod\n");

    expect(() =>
      scaffoldLocalModPackage({
        packageName: "hello-mod",
        sourceFile,
      }),
    ).toThrow("Mod file must be a .ts, .tsx, .js, or .mjs file");
  });

  test("rejects symlink source files", () => {
    if (process.platform === "win32") return;
    const root = createTempDir();
    const targetFile = path.join(root, "target.ts");
    const sourceFile = path.join(root, "linked.ts");
    writeFileSync(targetFile, "export default () => {};\n");
    symlinkSync(targetFile, sourceFile);

    expect(() =>
      scaffoldLocalModPackage({
        packageName: "hello-mod",
        sourceFile,
      }),
    ).toThrow("Mod file must not be a symlink");
  });

  test("rejects existing output directories", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "hello.ts");
    const outputDirectory = path.join(root, "hello-package");
    writeFileSync(sourceFile, "export default () => {};\n");
    mkdirSync(outputDirectory, { recursive: true });

    expect(() =>
      scaffoldLocalModPackage({
        outputDirectory,
        packageName: "hello-mod",
        sourceFile,
      }),
    ).toThrow("Output directory already exists");
  });
});
