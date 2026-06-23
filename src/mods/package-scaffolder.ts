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
  packageJsonPath: string;
  packageName: string;
  readmePath: string;
  sourceFile: string;
  targetModPath: string;
}

const DEFAULT_PACKAGE_VERSION = "0.1.0";
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
    keywords: [LETTA_MOD_KEYWORD],
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
  const installCommand = `letta install ${outputDirectory}`;

  try {
    mkdirSync(targetModsDirectory, { recursive: true });
    copyFileSync(sourceFile, targetModPath);
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(createPackageJson(packageName, manifestEntry), null, 2)}\n`,
    );
    writeFileSync(readmePath, createReadme(packageName));
  } catch (error) {
    rmSync(outputDirectory, { force: true, recursive: true });
    throw error;
  }

  return {
    installCommand,
    manifestEntry,
    outputDirectory,
    packageJsonPath,
    packageName,
    readmePath,
    sourceFile,
    targetModPath,
  };
}
