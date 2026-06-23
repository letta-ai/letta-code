import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
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
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type LettaPackageCapability,
  readLettaPackageManifest,
} from "@/mods/package-manifest";
import {
  getManagedModPackage,
  getManagedModPackageRootRelativePathForSource,
  MOD_PACKAGES_DIRECTORY_NAME,
  parseManagedNpmPackageSource,
  upsertManagedModPackage,
  validateManagedModPackageRegistryForMutation,
} from "@/mods/package-registry";

export interface InstallLocalManagedModPackageResult {
  capabilities: LettaPackageCapability[];
  entries: string[];
  packageDirectory: string;
  registryPath: string;
  repository?: string;
  root: string;
  rootRelativePath: string;
  source: string;
  version: string;
}

export interface UpdateNpmManagedModPackageResult
  extends InstallLocalManagedModPackageResult {
  enabled: boolean;
  previousVersion: string;
}

export interface NpmManagedModPackageInstallSpecifier {
  installSpec: string;
  packageName: string;
  source: string;
  version?: string;
}

interface PackageSourceInfo {
  capabilities: LettaPackageCapability[];
  entries: string[];
  packageDirectory: string;
  packageName: string;
  repository?: string;
  rootRelativePath: string;
  source: string;
  version: string;
}

interface InstallPreparedManagedModPackageParams {
  dependencyNodeModulesDirectory?: string;
  enabled?: boolean;
  modsRoot: string;
  packageDirectory: string;
}

type NpmInstallProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const SKIPPED_PACKAGE_COPY_NAMES = new Set([".git", "node_modules"]);

let spawnNpmInstallProcess: NpmInstallProcessFactory = spawn;
let platformOverride: NodeJS.Platform | null = null;

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

function formatRepository(repository: unknown): string | undefined {
  if (typeof repository === "string") {
    const trimmed = repository.trim();
    return trimmed || undefined;
  }
  if (!isRecord(repository)) return undefined;
  const url = repository.url;
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  return trimmed || undefined;
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

function validatePackageSource(packageDirectory: string): PackageSourceInfo {
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
  const packageName = parseManagedNpmPackageSource(source);
  const rootRelativePath =
    getManagedModPackageRootRelativePathForSource(source);
  if (!packageName || !rootRelativePath) {
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
  const repository = formatRepository(packageJson.repository);

  return {
    capabilities: manifestResult.manifest.capabilities ?? [],
    entries: manifestResult.manifest.mods,
    packageDirectory: resolvedPackageDirectory,
    packageName,
    ...(repository ? { repository } : {}),
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

function shouldSkipDependencyPath(
  relativeParts: string[],
  installedPackageName?: string,
): boolean {
  if (relativeParts.includes(".bin")) return true;
  if (!installedPackageName) return false;
  const packageParts = installedPackageName.split("/");
  return (
    relativeParts.length >= packageParts.length &&
    packageParts.every((part, index) => relativeParts[index] === part)
  );
}

function copyDependencyDirectoryFiltered(params: {
  installedPackageName?: string;
  relativeParts?: string[];
  sourceRoot: string;
  targetRoot: string;
}): boolean {
  let copied = false;
  const relativeParts = params.relativeParts ?? [];
  for (const entry of readdirSync(params.sourceRoot, { withFileTypes: true })) {
    const nextRelativeParts = [...relativeParts, entry.name];
    if (
      shouldSkipDependencyPath(nextRelativeParts, params.installedPackageName)
    ) {
      continue;
    }

    const sourcePath = path.join(params.sourceRoot, entry.name);
    const targetPath = path.join(params.targetRoot, entry.name);
    const stats = lstatSync(sourcePath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Package dependency contains unsupported symlink: ${sourcePath}`,
      );
    }
    if (stats.isDirectory()) {
      const copiedChild = copyDependencyDirectoryFiltered({
        installedPackageName: params.installedPackageName,
        relativeParts: nextRelativeParts,
        sourceRoot: sourcePath,
        targetRoot: targetPath,
      });
      copied ||= copiedChild;
      continue;
    }
    if (stats.isFile()) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
      copied = true;
      continue;
    }
    throw new Error(
      `Package dependency contains unsupported filesystem entry: ${sourcePath}`,
    );
  }
  return copied;
}

function copyDependencyNodeModules(params: {
  installedPackageName: string;
  sourceNodeModulesDirectory: string;
  targetPackageRoot: string;
}): void {
  if (!existsSync(params.sourceNodeModulesDirectory)) return;
  copyDependencyDirectoryFiltered({
    installedPackageName: params.installedPackageName,
    sourceRoot: params.sourceNodeModulesDirectory,
    targetRoot: path.join(params.targetPackageRoot, "node_modules"),
  });
}

function copyPackageInternalNodeModules(params: {
  packageDirectory: string;
  targetPackageRoot: string;
}): void {
  const sourceNodeModulesDirectory = path.join(
    params.packageDirectory,
    "node_modules",
  );
  if (!existsSync(sourceNodeModulesDirectory)) return;
  copyDependencyDirectoryFiltered({
    sourceRoot: sourceNodeModulesDirectory,
    targetRoot: path.join(params.targetPackageRoot, "node_modules"),
  });
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
  if (!params.backupRoot || !existsSync(params.backupRoot)) {
    rmSync(params.destinationRoot, { force: true, recursive: true });
    return;
  }
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

function installPreparedManagedModPackage(
  params: InstallPreparedManagedModPackageParams,
): InstallLocalManagedModPackageResult {
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
  let destinationNeedsRollback = false;

  try {
    copyPackageDirectory(packageInfo.packageDirectory, stagingRoot);
    if (params.dependencyNodeModulesDirectory) {
      copyDependencyNodeModules({
        installedPackageName: packageInfo.packageName,
        sourceNodeModulesDirectory: params.dependencyNodeModulesDirectory,
        targetPackageRoot: stagingRoot,
      });
      copyPackageInternalNodeModules({
        packageDirectory: packageInfo.packageDirectory,
        targetPackageRoot: stagingRoot,
      });
    }
    if (existsSync(destinationRoot)) {
      backupRoot = makeSiblingTempDirectory(destinationRoot, "backup");
      rmSync(backupRoot, { force: true, recursive: true });
      renameSync(destinationRoot, backupRoot);
      destinationNeedsRollback = true;
    }
    renameSync(stagingRoot, destinationRoot);
    destinationNeedsRollback = true;
    stagingRoot = null;

    try {
      const upsertResult = upsertManagedModPackage({
        enabled: params.enabled ?? true,
        entries: packageInfo.entries,
        modsRoot: params.modsRoot,
        source: packageInfo.source,
        version: packageInfo.version,
      });
      removeIfExists(backupRoot);
      backupRoot = null;
      destinationNeedsRollback = false;
      return {
        capabilities: packageInfo.capabilities,
        entries: packageInfo.entries,
        packageDirectory: packageInfo.packageDirectory,
        ...(packageInfo.repository
          ? { repository: packageInfo.repository }
          : {}),
        registryPath: upsertResult.registryPath,
        root: destinationRoot,
        rootRelativePath: packageInfo.rootRelativePath,
        source: packageInfo.source,
        version: packageInfo.version,
      };
    } catch (error) {
      if (destinationNeedsRollback) {
        restoreDestinationIfNeeded({ backupRoot, destinationRoot });
        backupRoot = null;
        destinationNeedsRollback = false;
      }
      restoreRegistry(registrySnapshot.registryPath, registrySnapshot.contents);
      throw error;
    }
  } catch (error) {
    removeIfExists(stagingRoot);
    if (destinationNeedsRollback) {
      restoreDestinationIfNeeded({ backupRoot, destinationRoot });
      backupRoot = null;
    }
    throw error;
  }
}

function getNpmExecutable(): string {
  return (platformOverride ?? process.platform) === "win32" ? "npm.cmd" : "npm";
}

function getNpmInstallArgs(installSpec: string): string[] {
  return [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--no-save",
    ...((platformOverride ?? process.platform) === "win32"
      ? ["--no-bin-links"]
      : []),
    installSpec,
  ];
}

function writeNpmInstallManifest(tempRoot: string): void {
  writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        name: "letta-managed-mod-install",
      },
      null,
      2,
    )}\n`,
  );
}

function runNpmInstall(params: {
  installSpec: string;
  tempRoot: string;
}): Promise<void> {
  const command = getNpmExecutable();
  const args = getNpmInstallArgs(params.installSpec);
  return new Promise((resolve, reject) => {
    const child = spawnNpmInstallProcess(command, args, {
      cwd: params.tempRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk) => {
      stdout.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr.push(String(chunk));
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const details = stderr.join("").trim() || stdout.join("").trim();
      reject(
        new Error(
          `npm install failed with code ${code ?? "unknown"}${details ? `: ${details}` : ""}`,
        ),
      );
    });
  });
}

function getInstalledPackageDirectory(
  nodeModulesDirectory: string,
  packageName: string,
): string {
  return path.join(nodeModulesDirectory, ...packageName.split("/"));
}

function isPlainNpmVersionOrTag(value: string): boolean {
  if (!value.trim()) return false;
  if (value !== value.trim()) return false;
  return !/[\s:/\\]/.test(value);
}

export function parseNpmManagedModPackageInstallSpecifier(
  specifier: string,
): NpmManagedModPackageInstallSpecifier {
  const trimmed = specifier.trim();
  if (!trimmed.startsWith("npm:")) {
    throw new Error(`Invalid npm mod package specifier: ${specifier}`);
  }

  const slashIndex = trimmed.lastIndexOf("/");
  const atIndex = trimmed.lastIndexOf("@");
  let source = trimmed;
  let version: string | undefined;
  if (atIndex > "npm:".length && atIndex > slashIndex) {
    source = trimmed.slice(0, atIndex);
    version = trimmed.slice(atIndex + 1);
    if (!version) {
      throw new Error(`Invalid npm mod package specifier: ${specifier}`);
    }
    if (!isPlainNpmVersionOrTag(version)) {
      throw new Error(`Invalid npm package version or tag: ${version}`);
    }
  }

  const packageName = parseManagedNpmPackageSource(source);
  if (!packageName) {
    throw new Error(`Invalid npm mod package specifier: ${specifier}`);
  }
  return {
    installSpec: version ? `${packageName}@${version}` : packageName,
    packageName,
    source,
    ...(version ? { version } : {}),
  };
}

export function installLocalManagedModPackage(params: {
  modsRoot: string;
  packageDirectory: string;
}): InstallLocalManagedModPackageResult {
  return installPreparedManagedModPackage(params);
}

export async function installNpmManagedModPackage(params: {
  modsRoot: string;
  specifier: string;
}): Promise<InstallLocalManagedModPackageResult> {
  const parsed = parseNpmManagedModPackageInstallSpecifier(params.specifier);
  const tempRoot = mkdtempSync(path.join(tmpdir(), "letta-mod-npm-"));
  try {
    writeNpmInstallManifest(tempRoot);
    await runNpmInstall({
      installSpec: parsed.installSpec,
      tempRoot,
    });
    const nodeModulesDirectory = path.join(tempRoot, "node_modules");
    const packageDirectory = getInstalledPackageDirectory(
      nodeModulesDirectory,
      parsed.packageName,
    );
    return installPreparedManagedModPackage({
      dependencyNodeModulesDirectory: nodeModulesDirectory,
      modsRoot: params.modsRoot,
      packageDirectory,
    });
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export async function updateNpmManagedModPackage(params: {
  modsRoot: string;
  specifier: string;
}): Promise<UpdateNpmManagedModPackageResult> {
  const parsed = parseNpmManagedModPackageInstallSpecifier(params.specifier);
  const existing = getManagedModPackage({
    modsRoot: params.modsRoot,
    specifier: parsed.source,
  }).package;
  const tempRoot = mkdtempSync(path.join(tmpdir(), "letta-mod-npm-"));
  try {
    writeNpmInstallManifest(tempRoot);
    await runNpmInstall({
      installSpec: parsed.installSpec,
      tempRoot,
    });
    const nodeModulesDirectory = path.join(tempRoot, "node_modules");
    const packageDirectory = getInstalledPackageDirectory(
      nodeModulesDirectory,
      parsed.packageName,
    );
    const updated = installPreparedManagedModPackage({
      dependencyNodeModulesDirectory: nodeModulesDirectory,
      enabled: existing.enabled,
      modsRoot: params.modsRoot,
      packageDirectory,
    });
    return {
      ...updated,
      enabled: existing.enabled,
      previousVersion: existing.version,
    };
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export function __testOverrideNpmManagedModPackageInstaller(params: {
  platform?: NodeJS.Platform | null;
  spawnImpl?: NpmInstallProcessFactory | null;
}): void {
  spawnNpmInstallProcess = params.spawnImpl ?? spawn;
  platformOverride = params.platform ?? null;
}
