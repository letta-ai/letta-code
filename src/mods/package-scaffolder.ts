import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isModFileExtension } from "@/mods/file-extensions";
import { LETTA_PACKAGE_MANIFEST_VERSION } from "@/mods/package-manifest";
import { parseManagedNpmPackageSource } from "@/mods/package-registry";

export interface ScaffoldLocalModPackageOptions {
  outputDirectory?: string;
  packageName: string;
  sourceFile: string;
}

export interface ScaffoldLocalModPackageResult {
  installCommand: string;
  manifestEntry: string;
  outputDirectory: string;
  modGuidePath: string;
  packageJsonPath: string;
  packageName: string;
  readmePath: string;
  sourceFile: string;
  targetModPath: string;
}

const DEFAULT_PACKAGE_VERSION = "0.1.0";
const LETTA_PACKAGE_KEYWORD = "letta-package";
const LETTA_MOD_KEYWORD = "letta-mod";

function assertValidPackageName(packageName: string): string {
  const trimmed = packageName.trim();
  if (!trimmed) {
    throw new Error("Package name is required");
  }
  const normalizedPackageName = parseManagedNpmPackageSource(`npm:${trimmed}`);
  if (!normalizedPackageName) {
    throw new Error("Package name must be a valid npm package name");
  }
  return normalizedPackageName;
}

function defaultOutputDirectory(
  sourceFile: string,
  packageName: string,
): string {
  const nameParts = packageName.split("/");
  const directoryName = nameParts[nameParts.length - 1] || packageName;
  return path.join(path.dirname(sourceFile), directoryName);
}

function readSourceFile(sourceFile: string): string {
  const resolvedSourceFile = path.resolve(sourceFile);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolvedSourceFile);
  } catch {
    throw new Error(`Mod file does not exist: ${sourceFile}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Mod file must not be a symlink: ${sourceFile}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Mod path must be a file: ${sourceFile}`);
  }
  if (!isModFileExtension(path.extname(resolvedSourceFile))) {
    throw new Error("Mod file must be a .ts, .tsx, .js, or .mjs file");
  }
  return resolvedSourceFile;
}

function createPackageJson(packageName: string, manifestEntry: string) {
  return {
    name: packageName,
    version: DEFAULT_PACKAGE_VERSION,
    type: "module",
    keywords: [LETTA_PACKAGE_KEYWORD, LETTA_MOD_KEYWORD],
    files: ["README.md", "MOD.md", "mods"],
    letta: {
      manifestVersion: LETTA_PACKAGE_MANIFEST_VERSION,
      mods: [manifestEntry],
    },
  };
}

function createReadme(packageName: string): string {
  return `# ${packageName}

Letta Code mod package.

## Install locally

\`\`\`bash
letta install .
\`\`\`

Run /reload in active sessions for changes to take effect.
`;
}

function createModGuide(packageName: string, manifestEntry: string): string {
  return `# ${packageName}

## Purpose

TODO: Describe what this mod does.

## Behavior

TODO: Describe commands, tools, events, permissions, providers, or UI surfaces this mod registers.

## Entry points

- \`${manifestEntry}\`

## Safety

This mod is trusted local code and can execute with the user's local permissions. Review the source before installing or modifying it.
`;
}

export function scaffoldLocalModPackage(
  options: ScaffoldLocalModPackageOptions,
): ScaffoldLocalModPackageResult {
  const sourceFile = readSourceFile(options.sourceFile);
  const packageName = assertValidPackageName(options.packageName);
  const outputDirectory = path.resolve(
    options.outputDirectory ?? defaultOutputDirectory(sourceFile, packageName),
  );
  if (existsSync(outputDirectory)) {
    throw new Error(`Output directory already exists: ${outputDirectory}`);
  }

  const modFileName = path.basename(sourceFile);
  const manifestEntry = `mods/${modFileName}`;
  const targetModsDirectory = path.join(outputDirectory, "mods");
  const targetModPath = path.join(targetModsDirectory, modFileName);
  const packageJsonPath = path.join(outputDirectory, "package.json");
  const readmePath = path.join(outputDirectory, "README.md");
  const modGuidePath = path.join(outputDirectory, "MOD.md");
  const installCommand = `letta install ${outputDirectory}`;

  try {
    mkdirSync(targetModsDirectory, { recursive: true });
    copyFileSync(sourceFile, targetModPath);
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(createPackageJson(packageName, manifestEntry), null, 2)}\n`,
    );
    writeFileSync(readmePath, createReadme(packageName));
    writeFileSync(modGuidePath, createModGuide(packageName, manifestEntry));
  } catch (error) {
    rmSync(outputDirectory, { force: true, recursive: true });
    throw error;
  }

  return {
    installCommand,
    manifestEntry,
    modGuidePath,
    outputDirectory,
    packageJsonPath,
    packageName,
    readmePath,
    sourceFile,
    targetModPath,
  };
}
