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
import { isModFileExtension } from "@/mods/file-extensions";
import {
  LETTA_PACKAGE_MANIFEST_VERSION,
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

export interface UpdateGitManagedModPackageResult
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

export interface GitManagedModPackageInstallSpecifier {
  cloneUrl: string;
  owner: string;
  ref?: string;
  repo: string;
  repository: string;
  source: string;
  subdir?: string;
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
  includePackageNodeModules?: boolean;
  modsRoot: string;
  packageDirectory: string;
  packageInfo?: PackageSourceInfo;
}

type ManagedPackageProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const SKIPPED_PACKAGE_COPY_NAMES = new Set([".git", "node_modules"]);

let spawnNpmInstallProcess: ManagedPackageProcessFactory = spawn;
let spawnGitInstallProcess: ManagedPackageProcessFactory = spawn;
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

function resolvePackageDirectory(packageDirectory: string): string {
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
  return resolvedPackageDirectory;
}

function validatePackageSource(packageDirectory: string): PackageSourceInfo {
  const resolvedPackageDirectory = resolvePackageDirectory(packageDirectory);

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
  const packageInfo =
    params.packageInfo ?? validatePackageSource(params.packageDirectory);
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
    }
    if (params.includePackageNodeModules) {
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

function getNpmInstallArgs(installSpec?: string): string[] {
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
    ...(installSpec ? [installSpec] : []),
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

function runProcess(params: {
  args: string[];
  command: string;
  cwd: string;
  spawnImpl: ManagedPackageProcessFactory;
}): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = params.spawnImpl(params.command, params.args, {
      cwd: params.cwd,
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
        resolve({ stderr: stderr.join(""), stdout: stdout.join("") });
        return;
      }
      const details = stderr.join("").trim() || stdout.join("").trim();
      reject(
        new Error(
          `${params.command} failed with code ${code ?? "unknown"}${details ? `: ${details}` : ""}`,
        ),
      );
    });
  });
}

async function runNpmInstall(params: {
  installSpec?: string;
  tempRoot: string;
}): Promise<void> {
  try {
    await runProcess({
      args: getNpmInstallArgs(params.installSpec),
      command: getNpmExecutable(),
      cwd: params.tempRoot,
      spawnImpl: spawnNpmInstallProcess,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.replace(/^npm(?:\.cmd)? failed/, "npm install failed"),
    );
  }
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

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function splitGitRef(value: string): { ref?: string; source: string } {
  const slashIndex = value.lastIndexOf("/");
  const atIndex = value.lastIndexOf("@");
  if (atIndex > slashIndex) {
    const source = value.slice(0, atIndex);
    const ref = value.slice(atIndex + 1);
    if (!source || !ref) {
      throw new Error(`Invalid git mod package specifier: ${value}`);
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(ref)) {
      throw new Error(`Invalid git ref: ${ref}`);
    }
    return { ref, source };
  }
  return { source: value };
}

function assertValidGitRef(ref: string): void {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}

function normalizeGitHubTreeSubdir(parts: string[]): string | undefined {
  if (parts.length === 0) return undefined;
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\0"),
    )
  ) {
    return undefined;
  }
  if (parts[0] !== "packages") return undefined;
  const normalized = path.posix.normalize(parts.join("/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeGitHubInstallSource(params: {
  owner: string;
  ref?: string;
  repo: string;
  subdir?: string;
}): GitManagedModPackageInstallSpecifier {
  const owner = params.owner.toLowerCase();
  const repo = stripGitSuffix(params.repo).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(owner)) {
    throw new Error(`Invalid GitHub owner: ${params.owner}`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(repo)) {
    throw new Error(`Invalid GitHub repository: ${params.repo}`);
  }
  const repository = `https://github.com/${owner}/${repo}`;
  const treeSource = params.subdir
    ? `${repository}/tree/${params.ref ?? "HEAD"}/${params.subdir}`
    : repository;
  return {
    cloneUrl: `${repository}.git`,
    owner,
    ...(params.ref ? { ref: params.ref } : {}),
    repo,
    repository,
    source: `git:${treeSource}`,
    ...(params.subdir ? { subdir: params.subdir } : {}),
  };
}

function parseGitHubHttpsInstallSource(
  specifier: string,
): GitManagedModPackageInstallSpecifier | null {
  const { ref, source } = splitGitRef(specifier);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 && (parts.length < 5 || parts[2] !== "tree")) {
    return null;
  }
  const treeRef = parts[2] === "tree" ? parts[3] : undefined;
  const treeSubdir =
    parts[2] === "tree" ? normalizeGitHubTreeSubdir(parts.slice(4)) : undefined;
  if (parts[2] === "tree" && (!treeRef || !treeSubdir)) return null;
  if (treeRef) assertValidGitRef(treeRef);
  return normalizeGitHubInstallSource({
    owner: parts[0] ?? "",
    ...(treeRef || ref ? { ref: ref ?? treeRef } : {}),
    repo: parts[1] ?? "",
    ...(treeSubdir ? { subdir: treeSubdir } : {}),
  });
}

function parseGitHubShorthandInstallSource(
  specifier: string,
): GitManagedModPackageInstallSpecifier | null {
  const { ref, source } = splitGitRef(specifier);
  const parts = source.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "github.com") return null;
  return normalizeGitHubInstallSource({
    owner: parts[1] ?? "",
    ...(ref ? { ref } : {}),
    repo: parts[2] ?? "",
  });
}

function parseGitHubSshInstallSource(
  specifier: string,
): GitManagedModPackageInstallSpecifier | null {
  const { ref, source } = splitGitRef(specifier);
  const scpMatch = source.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (scpMatch) {
    return normalizeGitHubInstallSource({
      owner: scpMatch[1] ?? "",
      ...(ref ? { ref } : {}),
      repo: scpMatch[2] ?? "",
    });
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "ssh:" || url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return normalizeGitHubInstallSource({
    owner: parts[0] ?? "",
    ...(ref ? { ref } : {}),
    repo: parts[1] ?? "",
  });
}

export function parseGitManagedModPackageInstallSpecifier(
  specifier: string,
): GitManagedModPackageInstallSpecifier | null {
  const trimmed = specifier.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("https://github.com/")) {
    return parseGitHubHttpsInstallSource(trimmed);
  }
  if (trimmed.startsWith("ssh://git@github.com/")) {
    return parseGitHubSshInstallSource(trimmed);
  }
  if (trimmed.startsWith("git@github.com:")) {
    return parseGitHubSshInstallSource(trimmed);
  }
  if (!trimmed.startsWith("git:")) return null;
  const gitSource = trimmed.slice("git:".length);
  if (gitSource.startsWith("https://github.com/")) {
    return parseGitHubHttpsInstallSource(gitSource);
  }
  if (gitSource.startsWith("ssh://git@github.com/")) {
    return parseGitHubSshInstallSource(gitSource);
  }
  if (gitSource.startsWith("git@github.com:")) {
    return parseGitHubSshInstallSource(gitSource);
  }
  return parseGitHubShorthandInstallSource(gitSource);
}

function hasRuntimeDependencies(
  packageJson: Record<string, unknown> | null,
): boolean {
  if (!packageJson) return false;
  const dependencies = packageJson.dependencies;
  return isRecord(dependencies) && Object.keys(dependencies).length > 0;
}

function readPackageJsonIfExists(
  packageDirectory: string,
): Record<string, unknown> | null {
  const packageJsonPath = path.join(packageDirectory, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  return readPackageJson(packageJsonPath);
}

function isRegularModFile(filePath: string): boolean {
  try {
    const stats = lstatSync(filePath);
    return !stats.isSymbolicLink() && stats.isFile();
  } catch {
    return false;
  }
}

function inferCompatibilityModEntries(packageDirectory: string): string[] {
  const modsDirectory = path.join(packageDirectory, "mods");
  if (existsSync(modsDirectory)) {
    const stats = lstatSync(modsDirectory);
    if (stats.isSymbolicLink()) {
      throw new Error(`Package mods directory must not be a symlink: mods`);
    }
    if (stats.isDirectory()) {
      const entries = readdirSync(modsDirectory, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && isModFileExtension(path.extname(entry.name)),
        )
        .map((entry) => `mods/${entry.name}`)
        .sort();
      if (entries.length > 0) return entries;
    }
  }

  for (const entry of [
    "src/mod.ts",
    "src/mod.tsx",
    "src/mod.js",
    "src/mod.mjs",
    "mod.ts",
    "mod.tsx",
    "mod.js",
    "mod.mjs",
  ]) {
    if (isRegularModFile(path.join(packageDirectory, ...entry.split("/")))) {
      return [entry];
    }
  }
  return [];
}

function getPackageNameForGitPackage(params: {
  packageJson: Record<string, unknown> | null;
  repo: string;
}): string {
  const name = params.packageJson?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return params.repo;
}

function getPackageVersionForGitPackage(params: {
  packageJson: Record<string, unknown> | null;
  revision: string;
}): string {
  const version = params.packageJson?.version;
  if (typeof version === "string" && version.trim()) return version.trim();
  return params.revision;
}

function writeCompatibilityPackageManifest(params: {
  entries: string[];
  packageDirectory: string;
  packageJson: Record<string, unknown> | null;
  packageName: string;
  version: string;
}): void {
  const packageJsonPath = path.join(params.packageDirectory, "package.json");
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify(
      {
        ...(params.packageJson ?? {}),
        name: params.packageName,
        version: params.version,
        letta: {
          manifestVersion: LETTA_PACKAGE_MANIFEST_VERSION,
          mods: params.entries,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function createGitPackageSourceInfo(params: {
  packageDirectory: string;
  parsed: GitManagedModPackageInstallSpecifier;
  revision: string;
}): PackageSourceInfo {
  const packageDirectory = resolvePackageDirectory(params.packageDirectory);
  let packageJson = readPackageJsonIfExists(packageDirectory);
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const packageName = getPackageNameForGitPackage({
    packageJson,
    repo: params.parsed.repo,
  });
  const version = getPackageVersionForGitPackage({
    packageJson,
    revision: params.revision,
  });
  let capabilities: LettaPackageCapability[] = [];
  let entries: string[];

  if (packageJson && Object.hasOwn(packageJson, "letta")) {
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
    entries = manifestResult.manifest.mods;
    capabilities = manifestResult.manifest.capabilities ?? [];
  } else {
    entries = inferCompatibilityModEntries(packageDirectory);
    if (entries.length === 0) {
      throw new Error(
        "GitHub repo is not an installable Letta mod package. Add package.json#letta or a conventional mod entry.",
      );
    }
    writeCompatibilityPackageManifest({
      entries,
      packageDirectory,
      packageJson,
      packageName,
      version,
    });
    packageJson = readPackageJson(packageJsonPath);
  }

  validateManifestEntriesExist(packageDirectory, entries);
  const rootRelativePath = getManagedModPackageRootRelativePathForSource(
    params.parsed.source,
  );
  if (!rootRelativePath) {
    throw new Error(
      `Invalid managed mod package source: ${params.parsed.source}`,
    );
  }
  return {
    capabilities,
    entries,
    packageDirectory,
    packageName,
    repository:
      formatRepository(packageJson?.repository) ?? params.parsed.repository,
    rootRelativePath,
    source: params.parsed.source,
    version,
  };
}

function resolveGitPackageDirectory(params: {
  parsed: GitManagedModPackageInstallSpecifier;
  repoDirectory: string;
}): string {
  if (!params.parsed.subdir) return params.repoDirectory;
  const resolvedRepoDirectory = path.resolve(params.repoDirectory);
  const resolvedPackageDirectory = path.resolve(
    resolvedRepoDirectory,
    ...params.parsed.subdir.split("/"),
  );
  if (!isPathInsideOrEqual(resolvedPackageDirectory, resolvedRepoDirectory)) {
    throw new Error(
      `Invalid GitHub package subdirectory: ${params.parsed.subdir}`,
    );
  }
  return resolvedPackageDirectory;
}

function getGitExecutable(): string {
  return "git";
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{
  stderr: string;
  stdout: string;
}> {
  return runProcess({
    args,
    command: getGitExecutable(),
    cwd,
    spawnImpl: spawnGitInstallProcess,
  });
}

async function checkoutGitPackage(params: {
  packageDirectory: string;
  parsed: GitManagedModPackageInstallSpecifier;
  tempRoot: string;
}): Promise<string> {
  const cloneArgs = params.parsed.ref
    ? ["clone", params.parsed.cloneUrl, params.packageDirectory]
    : [
        "clone",
        "--depth",
        "1",
        params.parsed.cloneUrl,
        params.packageDirectory,
      ];
  await runGit(cloneArgs, params.tempRoot);
  if (params.parsed.ref) {
    await runGit(
      ["checkout", "--detach", params.parsed.ref],
      params.packageDirectory,
    );
  }
  const revision = await runGit(
    ["rev-parse", "--short", "HEAD"],
    params.packageDirectory,
  );
  return revision.stdout.trim() || "unknown";
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
      includePackageNodeModules: true,
      modsRoot: params.modsRoot,
      packageDirectory,
    });
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export async function installGitManagedModPackage(params: {
  modsRoot: string;
  specifier: string;
}): Promise<InstallLocalManagedModPackageResult> {
  const parsed = parseGitManagedModPackageInstallSpecifier(params.specifier);
  if (!parsed) {
    throw new Error(`Invalid git mod package specifier: ${params.specifier}`);
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), "letta-mod-git-"));
  try {
    const repoDirectory = path.join(tempRoot, "repo");
    const revision = await checkoutGitPackage({
      packageDirectory: repoDirectory,
      parsed,
      tempRoot,
    });
    const packageDirectory = resolveGitPackageDirectory({
      parsed,
      repoDirectory,
    });
    const packageJson = readPackageJsonIfExists(packageDirectory);
    if (hasRuntimeDependencies(packageJson)) {
      await runNpmInstall({ tempRoot: packageDirectory });
    }
    const packageInfo = createGitPackageSourceInfo({
      packageDirectory,
      parsed,
      revision,
    });
    return installPreparedManagedModPackage({
      includePackageNodeModules: true,
      modsRoot: params.modsRoot,
      packageDirectory,
      packageInfo,
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
      includePackageNodeModules: true,
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

export async function updateGitManagedModPackage(params: {
  modsRoot: string;
  specifier: string;
}): Promise<UpdateGitManagedModPackageResult> {
  const parsed = parseGitManagedModPackageInstallSpecifier(params.specifier);
  if (!parsed) {
    throw new Error(`Invalid git mod package specifier: ${params.specifier}`);
  }
  const existing = getManagedModPackage({
    modsRoot: params.modsRoot,
    specifier: parsed.source,
  }).package;
  const tempRoot = mkdtempSync(path.join(tmpdir(), "letta-mod-git-"));
  try {
    const repoDirectory = path.join(tempRoot, "repo");
    const revision = await checkoutGitPackage({
      packageDirectory: repoDirectory,
      parsed,
      tempRoot,
    });
    const packageDirectory = resolveGitPackageDirectory({
      parsed,
      repoDirectory,
    });
    const packageJson = readPackageJsonIfExists(packageDirectory);
    if (hasRuntimeDependencies(packageJson)) {
      await runNpmInstall({ tempRoot: packageDirectory });
    }
    const packageInfo = createGitPackageSourceInfo({
      packageDirectory,
      parsed,
      revision,
    });
    const updated = installPreparedManagedModPackage({
      enabled: existing.enabled,
      includePackageNodeModules: true,
      modsRoot: params.modsRoot,
      packageDirectory,
      packageInfo,
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
  gitSpawnImpl?: ManagedPackageProcessFactory | null;
  platform?: NodeJS.Platform | null;
  spawnImpl?: ManagedPackageProcessFactory | null;
}): void {
  spawnGitInstallProcess = params.gitSpawnImpl ?? spawn;
  spawnNpmInstallProcess = params.spawnImpl ?? spawn;
  platformOverride = params.platform ?? null;
}
