import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type LettaPackageCapability,
  readLettaPackageManifest,
} from "@/mods/package-manifest";
import {
  getManagedModPackageRootRelativePathForSource,
  MOD_PACKAGES_DIRECTORY_NAME,
  upsertManagedModPackage,
  validateManagedModPackageRegistryForMutation,
} from "@/mods/package-registry";

export interface InstallLocalManagedModPackageResult {
  capabilities: LettaPackageCapability[];
  entries: string[];
  packageDirectory: string;
  registryPath: string;
  root: string;
  rootRelativePath: string;
  source: string;
  version: string;
}

const SKIPPED_PACKAGE_COPY_NAMES = new Set([".git", "node_modules"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function readPackageJson(packageJsonPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("package.json must be an object");
  }
  return parsed;
}

export function isLocalLettaModPackageDirectory(
  packageDirectory: string,
): boolean {
  const resolvedPackageDirectory = path.resolve(packageDirectory);
  try {
    const packageStats = lstatSync(resolvedPackageDirectory);
    if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) {
      return false;
    }
    const packageJson = readPackageJson(
      path.join(resolvedPackageDirectory, "package.json"),
    );
    return Object.hasOwn(packageJson, "letta");
  } catch {
    return false;
  }
}

function normalizeModEntry(entry: string): string {
  return path.posix.normalize(entry);
}

function resolvePackageRelativePath(
  packageRoot: string,
  relativePath: string,
): string {
  const normalized = normalizeModEntry(relativePath);
  const resolvedRoot = path.resolve(packageRoot);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!isPathInsideOrEqual(resolved, resolvedRoot)) {
    throw new Error(
      `Package path '${relativePath}' resolves outside the package root`,
    );
  }
  return resolved;
}

function validateManifestEntriesExist(
  packageRoot: string,
  entries: string[],
): void {
  for (const entry of entries) {
    const entryPath = resolvePackageRelativePath(packageRoot, entry);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(entryPath);
    } catch {
      throw new Error(`Package mod entry does not exist: ${entry}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Package mod entry must not be a symlink: ${entry}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Package mod entry must be a file: ${entry}`);
    }
  }
}

function validatePackageSource(packageDirectory: string): {
  capabilities: LettaPackageCapability[];
  entries: string[];
  packageDirectory: string;
  rootRelativePath: string;
  source: string;
  version: string;
} {
  const resolvedPackageDirectory = path.resolve(packageDirectory);
  let packageStats: ReturnType<typeof lstatSync>;
  try {
    packageStats = lstatSync(resolvedPackageDirectory);
  } catch {
    throw new Error(`Package directory does not exist: ${packageDirectory}`);
  }
  if (packageStats.isSymbolicLink()) {
    throw new Error(
      `Package directory must not be a symlink: ${packageDirectory}`,
    );
  }
  if (!packageStats.isDirectory()) {
    throw new Error(`Package path must be a directory: ${packageDirectory}`);
  }

  const packageJsonPath = path.join(resolvedPackageDirectory, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  const name = packageJson.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("package.json.name must be a valid npm package name");
  }
  const source = `npm:${name.trim()}`;
  const rootRelativePath =
    getManagedModPackageRootRelativePathForSource(source);
  if (!rootRelativePath) {
    throw new Error("package.json.name must be a valid npm package name");
  }

  const version = packageJson.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("package.json.version must be a string");
  }

  const manifestResult = readLettaPackageManifest(packageJsonPath);
  if (!manifestResult.ok) {
    throw new Error(
      manifestResult.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("\n"),
    );
  }
  if (!manifestResult.manifest) {
    throw new Error("Package does not include a package.json#letta manifest");
  }
  validateManifestEntriesExist(
    resolvedPackageDirectory,
    manifestResult.manifest.mods,
  );

  return {
    capabilities: manifestResult.manifest.capabilities ?? [],
    entries: manifestResult.manifest.mods,
    packageDirectory: resolvedPackageDirectory,
    rootRelativePath,
    source,
    version: version.trim(),
  };
}

function copyPackageDirectory(sourceRoot: string, targetRoot: string): void {
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (SKIPPED_PACKAGE_COPY_NAMES.has(entry.name)) continue;
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    const stats = lstatSync(sourcePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Package contains unsupported symlink: ${sourcePath}`);
    }
    if (stats.isDirectory()) {
      copyPackageDirectory(sourcePath, targetPath);
      continue;
    }
    if (stats.isFile()) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
      continue;
    }
    throw new Error(
      `Package contains unsupported filesystem entry: ${sourcePath}`,
    );
  }
}

function restoreRegistry(
  registryPath: string,
  previousContents: string | null,
): void {
  if (previousContents === null) {
    rmSync(registryPath, { force: true });
    return;
  }
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, previousContents);
}

function removeIfExists(targetPath: string | null): void {
  if (!targetPath) return;
  rmSync(targetPath, { force: true, recursive: true });
}

function restoreDestination(params: {
  backupRoot: string | null;
  destinationRoot: string;
}): void {
  rmSync(params.destinationRoot, { force: true, recursive: true });
  if (params.backupRoot && existsSync(params.backupRoot)) {
    renameSync(params.backupRoot, params.destinationRoot);
  }
}

function restoreDestinationIfNeeded(params: {
  backupRoot: string | null;
  destinationRoot: string;
}): void {
  if (!params.backupRoot || !existsSync(params.backupRoot)) return;
  restoreDestination(params);
}

function makeSiblingTempDirectory(
  destinationRoot: string,
  label: "backup" | "tmp",
): string {
  const parent = path.dirname(destinationRoot);
  const baseName = path
    .basename(destinationRoot)
    .replace(/[^a-zA-Z0-9._-]/g, "-");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, `.${baseName}.${label}-`));
}

export function installLocalManagedModPackage(params: {
  modsRoot: string;
  packageDirectory: string;
}): InstallLocalManagedModPackageResult {
  const packageInfo = validatePackageSource(params.packageDirectory);
  const packagesRoot = path.resolve(
    params.modsRoot,
    MOD_PACKAGES_DIRECTORY_NAME,
  );
  if (isPathInsideOrEqual(packageInfo.packageDirectory, packagesRoot)) {
    throw new Error(
      "Cannot install a package from inside the managed packages directory",
    );
  }
  const destinationRoot = path.resolve(
    params.modsRoot,
    ...packageInfo.rootRelativePath.split("/"),
  );
  if (isPathInsideOrEqual(destinationRoot, packageInfo.packageDirectory)) {
    throw new Error(
      "Cannot install a package into one of its own subdirectories",
    );
  }

  const registrySnapshot = validateManagedModPackageRegistryForMutation(
    params.modsRoot,
  );
  let stagingRoot: string | null = makeSiblingTempDirectory(
    destinationRoot,
    "tmp",
  );
  let backupRoot: string | null = null;

  try {
    copyPackageDirectory(packageInfo.packageDirectory, stagingRoot);
    if (existsSync(destinationRoot)) {
      backupRoot = makeSiblingTempDirectory(destinationRoot, "backup");
      rmSync(backupRoot, { force: true, recursive: true });
      renameSync(destinationRoot, backupRoot);
    }
    renameSync(stagingRoot, destinationRoot);
    stagingRoot = null;

    try {
      const upsertResult = upsertManagedModPackage({
        entries: packageInfo.entries,
        modsRoot: params.modsRoot,
        source: packageInfo.source,
        version: packageInfo.version,
      });
      removeIfExists(backupRoot);
      backupRoot = null;
      return {
        capabilities: packageInfo.capabilities,
        entries: packageInfo.entries,
        packageDirectory: packageInfo.packageDirectory,
        registryPath: upsertResult.registryPath,
        root: destinationRoot,
        rootRelativePath: packageInfo.rootRelativePath,
        source: packageInfo.source,
        version: packageInfo.version,
      };
    } catch (error) {
      restoreDestinationIfNeeded({ backupRoot, destinationRoot });
      backupRoot = null;
      restoreRegistry(registrySnapshot.registryPath, registrySnapshot.contents);
      throw error;
    }
  } catch (error) {
    removeIfExists(stagingRoot);
    restoreDestinationIfNeeded({ backupRoot, destinationRoot });
    backupRoot = null;
    throw error;
  }
}
