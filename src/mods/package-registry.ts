import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  isSafeLettaPackageModEntryPath,
  type LettaPackageCapability,
  readLettaPackageManifest,
} from "@/mods/package-manifest";

export const MOD_PACKAGES_REGISTRY_FILENAME = "packages.json";
export const MOD_PACKAGES_DIRECTORY_NAME = "packages";

export interface ManagedModPackageSource {
  entries: string[];
  files: string[];
  root: string;
  source: string;
  version: string;
}

export interface ManagedModPackageDiagnostic {
  error: Error;
  path: string;
}

export interface ResolveManagedModPackagesResult {
  diagnostics: ManagedModPackageDiagnostic[];
  files: string[];
  packages: ManagedModPackageSource[];
}

export interface ManagedModPackageListItem {
  capabilities: LettaPackageCapability[];
  enabled: boolean;
  entries: string[];
  files: string[];
  registryIndex: number;
  root: string;
  rootRelativePath: string;
  source: string;
  version: string;
}

export interface ListManagedModPackagesResult {
  diagnostics: ManagedModPackageDiagnostic[];
  packages: ManagedModPackageListItem[];
  registryExists: boolean;
  registryPath: string;
}

export interface ManagedModPackageMutationResult {
  package: ManagedModPackageListItem;
  registryPath: string;
  removedRoot?: string;
}

export interface ManagedModPackageRegistrySnapshot {
  contents: string | null;
  registryPath: string;
}

export interface UpsertManagedModPackageResult
  extends ManagedModPackageMutationResult {
  removedDuplicates: number;
  replaced: boolean;
}

const PACKAGE_ENTRY_KEYS = new Set([
  "source",
  "version",
  "enabled",
  "root",
  "entries",
]);
const PACKAGE_REGISTRY_KEYS = new Set(["packages"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDiagnostic(
  diagnosticPath: string,
  message: string,
): ManagedModPackageDiagnostic {
  return {
    error: new Error(message),
    path: diagnosticPath,
  };
}

function getUnknownKeys(
  value: Record<string, unknown>,
  knownKeys: Set<string>,
): string[] {
  return Object.keys(value).filter((key) => !knownKeys.has(key));
}

function isWindowsAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function normalizeRelativePath(value: string): string | null {
  if (!value.trim()) return null;
  if (value.includes("\0")) return null;
  if (value.includes("\\")) return null;
  if (path.posix.isAbsolute(value) || path.isAbsolute(value)) return null;
  if (isWindowsAbsolutePath(value)) return null;

  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === "") return null;
  if (normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function resolveRelativePath(
  root: string,
  relativePath: string,
): string | null {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  const rootWithSeparator = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSeparator)) {
    return null;
  }
  return resolved;
}

function parseJsonFile(filePath: string):
  | {
      ok: true;
      value: unknown;
    }
  | {
      error: ManagedModPackageDiagnostic;
      ok: false;
    } {
  try {
    return {
      ok: true,
      value: JSON.parse(readFileSync(filePath, "utf8")),
    };
  } catch (error) {
    return {
      error: createDiagnostic(
        filePath,
        error instanceof Error ? error.message : String(error),
      ),
      ok: false,
    };
  }
}

function getRegistryPath(modsRoot: string): string {
  return path.join(modsRoot, MOD_PACKAGES_REGISTRY_FILENAME);
}

function readRegistryObject(modsRoot: string):
  | {
      diagnostics: ManagedModPackageDiagnostic[];
      ok: true;
      packagesValue: unknown[];
      registry: Record<string, unknown>;
      registryPath: string;
    }
  | {
      diagnostics: ManagedModPackageDiagnostic[];
      ok: false;
      registryExists: boolean;
      registryPath: string;
    } {
  const registryPath = getRegistryPath(modsRoot);
  if (!existsSync(registryPath)) {
    return { diagnostics: [], ok: false, registryExists: false, registryPath };
  }

  const registryResult = parseJsonFile(registryPath);
  if (!registryResult.ok) {
    return {
      diagnostics: [registryResult.error],
      ok: false,
      registryExists: true,
      registryPath,
    };
  }
  if (!isRecord(registryResult.value)) {
    return {
      diagnostics: [
        createDiagnostic(registryPath, "packages.json must be an object"),
      ],
      ok: false,
      registryExists: true,
      registryPath,
    };
  }

  const diagnostics: ManagedModPackageDiagnostic[] = [];
  for (const key of getUnknownKeys(
    registryResult.value,
    PACKAGE_REGISTRY_KEYS,
  )) {
    diagnostics.push(
      createDiagnostic(
        `packages.json.${key}`,
        `unknown registry field '${key}'`,
      ),
    );
  }

  const packagesValue = registryResult.value.packages;
  if (!Array.isArray(packagesValue)) {
    diagnostics.push(
      createDiagnostic("packages.json.packages", "packages must be an array"),
    );
    return {
      diagnostics,
      ok: false,
      registryExists: true,
      registryPath,
    };
  }

  return {
    diagnostics,
    ok: true,
    packagesValue,
    registry: registryResult.value,
    registryPath,
  };
}

function validatePackageEntries(
  value: unknown,
  diagnosticPath: string,
):
  | {
      diagnostics: ManagedModPackageDiagnostic[];
      entries: string[];
      ok: true;
    }
  | {
      diagnostics: ManagedModPackageDiagnostic[];
      ok: false;
    } {
  const diagnostics: ManagedModPackageDiagnostic[] = [];
  if (!Array.isArray(value)) {
    return {
      diagnostics: [
        createDiagnostic(diagnosticPath, "package entries must be an array"),
      ],
      ok: false,
    };
  }
  if (value.length === 0) {
    return {
      diagnostics: [
        createDiagnostic(diagnosticPath, "package entries must not be empty"),
      ],
      ok: false,
    };
  }

  const entries: string[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${diagnosticPath}[${index}]`;
    if (typeof entry !== "string") {
      diagnostics.push(
        createDiagnostic(entryPath, "package entry must be a string"),
      );
      return;
    }
    if (!isSafeLettaPackageModEntryPath(entry)) {
      diagnostics.push(
        createDiagnostic(
          entryPath,
          "package entry must be a safe relative .ts, .tsx, .js, or .mjs path",
        ),
      );
      return;
    }
    entries.push(entry);
  });

  if (diagnostics.length > 0) {
    return { diagnostics, ok: false };
  }
  return { diagnostics: [], entries, ok: true };
}

function normalizeModEntry(value: string): string {
  return path.posix.normalize(value);
}

function resolvePackageEntry(
  packageRoot: string,
  entry: string,
): string | null {
  const normalized = normalizeModEntry(entry);
  return resolveRelativePath(packageRoot, normalized);
}

function validatePackageMetadata(
  modsRoot: string,
  rawEntry: unknown,
  index: number,
):
  | {
      diagnostics: ManagedModPackageDiagnostic[];
      ok: false;
    }
  | {
      diagnostics: ManagedModPackageDiagnostic[];
      enabled: boolean;
      entries: string[];
      files: string[];
      ok: true;
      packageRoot: string;
      rootRelativePath: string;
      source: string;
      version: string;
    } {
  const diagnosticPath = `packages[${index}]`;
  if (!isRecord(rawEntry)) {
    return {
      diagnostics: [
        createDiagnostic(
          diagnosticPath,
          "package registry entry must be an object",
        ),
      ],
      ok: false,
    };
  }

  const diagnostics: ManagedModPackageDiagnostic[] = [];
  for (const key of getUnknownKeys(rawEntry, PACKAGE_ENTRY_KEYS)) {
    diagnostics.push(
      createDiagnostic(
        `${diagnosticPath}.${key}`,
        `unknown package field '${key}'`,
      ),
    );
  }

  const source = rawEntry.source;
  const version = rawEntry.version;
  const enabled = rawEntry.enabled;
  if (typeof source !== "string" || !source.trim()) {
    diagnostics.push(
      createDiagnostic(
        `${diagnosticPath}.source`,
        "package source must be a string",
      ),
    );
  }
  if (typeof version !== "string" || !version.trim()) {
    diagnostics.push(
      createDiagnostic(
        `${diagnosticPath}.version`,
        "package version must be a string",
      ),
    );
  }
  if (typeof enabled !== "boolean") {
    diagnostics.push(
      createDiagnostic(
        `${diagnosticPath}.enabled`,
        "package enabled must be a boolean",
      ),
    );
  }
  if (typeof rawEntry.root !== "string") {
    diagnostics.push(
      createDiagnostic(
        `${diagnosticPath}.root`,
        "package root must be a string",
      ),
    );
  }

  if (
    diagnostics.length > 0 ||
    typeof source !== "string" ||
    typeof version !== "string" ||
    typeof enabled !== "boolean" ||
    typeof rawEntry.root !== "string"
  ) {
    return { diagnostics, ok: false };
  }

  const packageRoot = resolveRelativePath(modsRoot, rawEntry.root);
  if (!packageRoot) {
    return {
      diagnostics: [
        createDiagnostic(
          `${diagnosticPath}.root`,
          "package root must be a safe relative path",
        ),
      ],
      ok: false,
    };
  }

  const entriesResult = validatePackageEntries(
    rawEntry.entries,
    `${diagnosticPath}.entries`,
  );
  if (!entriesResult.ok) {
    return { diagnostics: entriesResult.diagnostics, ok: false };
  }

  const files: string[] = [];
  for (const entry of entriesResult.entries) {
    const entryPath = resolvePackageEntry(packageRoot, entry);
    if (!entryPath) {
      diagnostics.push(
        createDiagnostic(
          `${diagnosticPath}.entries`,
          `Package entry '${entry}' resolves outside the package root`,
        ),
      );
      continue;
    }
    files.push(entryPath);
  }
  if (diagnostics.length > 0) {
    return { diagnostics, ok: false };
  }

  return {
    diagnostics: [],
    enabled,
    entries: entriesResult.entries,
    files,
    ok: true,
    packageRoot,
    rootRelativePath: rawEntry.root,
    source,
    version,
  };
}

function resolvePackage(
  modsRoot: string,
  rawEntry: unknown,
  index: number,
):
  | {
      diagnostics: ManagedModPackageDiagnostic[];
      ok: false;
    }
  | {
      diagnostics: [];
      files: string[];
      ok: true;
      packageSource: ManagedModPackageSource | null;
    } {
  const metadata = validatePackageMetadata(modsRoot, rawEntry, index);
  if (!metadata.ok) {
    return { diagnostics: metadata.diagnostics, ok: false };
  }
  if (!metadata.enabled) {
    return { diagnostics: [], files: [], ok: true, packageSource: null };
  }

  const packageJsonPath = path.join(metadata.packageRoot, "package.json");
  const manifestResult = readLettaPackageManifest(packageJsonPath);
  if (!manifestResult.ok) {
    return {
      diagnostics: manifestResult.errors.map((error) =>
        createDiagnostic(
          packageJsonPath,
          `Invalid package manifest at ${error.path}: ${error.message}`,
        ),
      ),
      ok: false,
    };
  }
  if (!manifestResult.manifest) {
    return {
      diagnostics: [
        createDiagnostic(
          packageJsonPath,
          "Package does not include a package.json#letta manifest",
        ),
      ],
      ok: false,
    };
  }

  const manifestEntries = new Set(
    manifestResult.manifest.mods.map(normalizeModEntry),
  );
  const files: string[] = [];
  const diagnostics: ManagedModPackageDiagnostic[] = [];
  for (const entry of metadata.entries) {
    const normalizedEntry = normalizeModEntry(entry);
    if (!manifestEntries.has(normalizedEntry)) {
      diagnostics.push(
        createDiagnostic(
          `packages[${index}].entries`,
          `Package entry '${entry}' is not declared in package.json#letta.mods`,
        ),
      );
      continue;
    }
    const entryPath = resolvePackageEntry(
      metadata.packageRoot,
      normalizedEntry,
    );
    if (!entryPath) {
      diagnostics.push(
        createDiagnostic(
          `packages[${index}].entries`,
          `Package entry '${entry}' resolves outside the package root`,
        ),
      );
      continue;
    }
    files.push(entryPath);
  }

  if (diagnostics.length > 0) {
    return { diagnostics, ok: false };
  }

  return {
    diagnostics: [],
    files,
    ok: true,
    packageSource: {
      entries: metadata.entries,
      files,
      root: metadata.packageRoot,
      source: metadata.source,
      version: metadata.version,
    },
  };
}

export function resolveManagedModPackages(
  modsRoot: string,
): ResolveManagedModPackagesResult {
  const registryResult = readRegistryObject(modsRoot);
  if (!registryResult.ok) {
    if (!registryResult.registryExists) {
      return { diagnostics: [], files: [], packages: [] };
    }
    return { diagnostics: registryResult.diagnostics, files: [], packages: [] };
  }

  const diagnostics: ManagedModPackageDiagnostic[] = [
    ...registryResult.diagnostics,
  ];
  const files: string[] = [];
  const packages: ManagedModPackageSource[] = [];
  registryResult.packagesValue.forEach((entry, index) => {
    const result = resolvePackage(modsRoot, entry, index);
    diagnostics.push(...result.diagnostics);
    if (!result.ok) return;
    files.push(...result.files);
    if (result.packageSource) {
      packages.push(result.packageSource);
    }
  });

  return { diagnostics, files, packages };
}

export function listManagedModPackages(
  modsRoot: string,
): ListManagedModPackagesResult {
  const registryResult = readRegistryObject(modsRoot);
  if (!registryResult.ok) {
    return {
      diagnostics: registryResult.diagnostics,
      packages: [],
      registryExists: registryResult.registryExists,
      registryPath: registryResult.registryPath,
    };
  }

  const diagnostics: ManagedModPackageDiagnostic[] = [
    ...registryResult.diagnostics,
  ];
  const packages: ManagedModPackageListItem[] = [];
  registryResult.packagesValue.forEach((entry, index) => {
    const metadata = validatePackageMetadata(modsRoot, entry, index);
    diagnostics.push(...metadata.diagnostics);
    if (!metadata.ok) return;

    const packageJsonPath = path.join(metadata.packageRoot, "package.json");
    const manifestResult = readLettaPackageManifest(packageJsonPath);
    let capabilities: LettaPackageCapability[] = [];
    if (!manifestResult.ok) {
      diagnostics.push(
        ...manifestResult.errors.map((error) =>
          createDiagnostic(
            packageJsonPath,
            `Invalid package manifest at ${error.path}: ${error.message}`,
          ),
        ),
      );
    } else if (manifestResult.manifest) {
      capabilities = manifestResult.manifest.capabilities ?? [];
    } else {
      diagnostics.push(
        createDiagnostic(
          packageJsonPath,
          "Package does not include a package.json#letta manifest",
        ),
      );
    }

    packages.push({
      capabilities,
      enabled: metadata.enabled,
      entries: metadata.entries,
      files: metadata.files,
      registryIndex: index,
      root: metadata.packageRoot,
      rootRelativePath: metadata.rootRelativePath,
      source: metadata.source,
      version: metadata.version,
    });
  });

  return {
    diagnostics,
    packages,
    registryExists: true,
    registryPath: registryResult.registryPath,
  };
}

function parseManagedPackageSpec(specifier: string): {
  source: string;
  version?: string;
} {
  const trimmed = specifier.trim();
  if (!trimmed) {
    throw new Error("Missing package specifier.");
  }
  const slashIndex = trimmed.lastIndexOf("/");
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex > slashIndex) {
    const source = trimmed.slice(0, atIndex);
    const version = trimmed.slice(atIndex + 1);
    if (!source || !version) {
      throw new Error(`Invalid package specifier: ${specifier}`);
    }
    return { source, version };
  }

  return { source: trimmed };
}

function formatManagedPackageSpecifier(pkg: {
  source: string;
  version: string;
}): string {
  return `${pkg.source}@${pkg.version}`;
}

function isValidNpmPackageNamePart(value: string): boolean {
  return /^[a-z0-9][a-z0-9._~-]*$/.test(value);
}

export function parseManagedNpmPackageSource(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const packageName = source.slice("npm:".length);
  const normalizedPackageName = normalizeRelativePath(packageName);
  if (!normalizedPackageName) return null;
  const packageNameParts = normalizedPackageName.split("/");
  const isScopedPackage =
    packageNameParts.length === 2 &&
    Boolean(packageNameParts[0]?.startsWith("@")) &&
    isValidNpmPackageNamePart(packageNameParts[0]?.slice(1) ?? "") &&
    isValidNpmPackageNamePart(packageNameParts[1] ?? "");
  const isUnscopedPackage =
    packageNameParts.length === 1 &&
    !packageNameParts[0]?.startsWith("@") &&
    isValidNpmPackageNamePart(packageNameParts[0] ?? "");
  if (!isScopedPackage && !isUnscopedPackage) return null;
  return normalizedPackageName;
}

export interface ManagedGitPackageSource {
  host: "github.com";
  owner: string;
  pathParts: string[];
  repo: string;
}

function isValidGitHubPathPart(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

export function parseManagedGitPackageSource(
  source: string,
): ManagedGitPackageSource | null {
  const prefix = "git:https://github.com/";
  if (!source.startsWith(prefix)) return null;
  const repoPath = source.slice(prefix.length).replace(/\.git$/i, "");
  const normalizedRepoPath = normalizeRelativePath(repoPath);
  if (!normalizedRepoPath) return null;
  const parts = normalizedRepoPath.split("/");
  if (parts.length !== 2 && (parts.length < 5 || parts[2] !== "tree")) {
    return null;
  }
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (!isValidGitHubPathPart(owner) || !isValidGitHubPathPart(repo)) {
    return null;
  }
  const pathParts = parts.length > 2 ? parts.slice(2) : [];
  return {
    host: "github.com",
    owner: owner.toLowerCase(),
    pathParts,
    repo: repo.toLowerCase(),
  };
}

export function getManagedModPackageRootRelativePathForSource(
  source: string,
): string | null {
  const packageName = parseManagedNpmPackageSource(source);
  if (packageName) return `${MOD_PACKAGES_DIRECTORY_NAME}/npm/${packageName}`;
  const gitSource = parseManagedGitPackageSource(source);
  if (gitSource) {
    return [
      MOD_PACKAGES_DIRECTORY_NAME,
      "git",
      gitSource.host,
      gitSource.owner,
      gitSource.repo,
      ...gitSource.pathParts,
    ].join("/");
  }
  return null;
}

function assertSafePackageRemovalRoot(
  metadata: Extract<ReturnType<typeof validatePackageMetadata>, { ok: true }>,
): void {
  const normalizedRoot = normalizeRelativePath(metadata.rootRelativePath);
  const expectedRoot = getManagedModPackageRootRelativePathForSource(
    metadata.source,
  );
  if (!normalizedRoot || !expectedRoot || normalizedRoot !== expectedRoot) {
    throw new Error(
      `Refusing to remove ${formatManagedPackageSpecifier(metadata)} because registry root '${metadata.rootRelativePath}' does not match expected package root '${expectedRoot ?? "(unknown)"}'.`,
    );
  }
}

function readMutablePackageRegistry(
  modsRoot: string,
  options: { createIfMissing?: boolean } = {},
): {
  packagesValue: unknown[];
  registry: Record<string, unknown>;
  registryPath: string;
} {
  const result = readRegistryObject(modsRoot);
  if (!result.ok) {
    if (!result.registryExists) {
      if (options.createIfMissing) {
        const packagesValue: unknown[] = [];
        return {
          packagesValue,
          registry: { packages: packagesValue },
          registryPath: result.registryPath,
        };
      }
      throw new Error("No managed mod packages are installed.");
    }
    throw new Error(
      result.diagnostics[0]?.error.message ?? "Invalid packages.json",
    );
  }
  if (result.diagnostics.length > 0) {
    throw new Error(
      result.diagnostics[0]?.error.message ?? "Invalid packages.json",
    );
  }
  return {
    packagesValue: result.packagesValue,
    registry: result.registry,
    registryPath: result.registryPath,
  };
}

function getPackageMetadataForMutation(
  modsRoot: string,
  rawEntry: unknown,
  index: number,
): Extract<ReturnType<typeof validatePackageMetadata>, { ok: true }> {
  const metadata = validatePackageMetadata(modsRoot, rawEntry, index);
  if (!metadata.ok) {
    throw new Error(
      metadata.diagnostics[0]?.error.message ?? "Invalid package entry",
    );
  }
  return metadata;
}

function validatePackageRegistryEntriesForMutation(
  modsRoot: string,
  packagesValue: unknown[],
): void {
  packagesValue.forEach((entry, index) => {
    getPackageMetadataForMutation(modsRoot, entry, index);
  });
}

function findPackageIndex(
  modsRoot: string,
  packagesValue: unknown[],
  specifier: string,
): {
  index: number;
  metadata: Extract<ReturnType<typeof validatePackageMetadata>, { ok: true }>;
} {
  const spec = parseManagedPackageSpec(specifier);
  const matches: Array<{
    index: number;
    metadata: Extract<ReturnType<typeof validatePackageMetadata>, { ok: true }>;
  }> = [];

  packagesValue.forEach((entry, index) => {
    const metadata = getPackageMetadataForMutation(modsRoot, entry, index);
    if (metadata.source !== spec.source) return;
    if (spec.version && metadata.version !== spec.version) return;
    matches.push({ index, metadata });
  });

  if (matches.length === 0) {
    throw new Error(`Managed mod package not found: ${specifier}`);
  }
  const firstMatch = matches[0];
  if (!firstMatch) {
    throw new Error(`Managed mod package not found: ${specifier}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple versions match ${specifier}. Pass a versioned specifier like ${formatManagedPackageSpecifier(firstMatch.metadata)}.`,
    );
  }

  return firstMatch;
}

function writePackageRegistry(
  registryPath: string,
  registry: Record<string, unknown>,
): void {
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

export function validateManagedModPackageRegistryForMutation(
  modsRoot: string,
): ManagedModPackageRegistrySnapshot {
  const registryPath = getRegistryPath(modsRoot);
  const contents = existsSync(registryPath)
    ? readFileSync(registryPath, "utf8")
    : null;
  const registry = readMutablePackageRegistry(modsRoot, {
    createIfMissing: true,
  });
  validatePackageRegistryEntriesForMutation(modsRoot, registry.packagesValue);
  return { contents, registryPath };
}

function mutationItem(
  metadata: Extract<ReturnType<typeof validatePackageMetadata>, { ok: true }>,
  index: number,
  enabled: boolean,
): ManagedModPackageListItem {
  return {
    capabilities: [],
    enabled,
    entries: metadata.entries,
    files: metadata.files,
    registryIndex: index,
    root: metadata.packageRoot,
    rootRelativePath: metadata.rootRelativePath,
    source: metadata.source,
    version: metadata.version,
  };
}

export function setManagedModPackageEnabled(params: {
  enabled: boolean;
  modsRoot: string;
  specifier: string;
}): ManagedModPackageMutationResult {
  const registry = readMutablePackageRegistry(params.modsRoot);
  const match = findPackageIndex(
    params.modsRoot,
    registry.packagesValue,
    params.specifier,
  );
  const rawEntry = registry.packagesValue[match.index];
  if (!isRecord(rawEntry)) {
    throw new Error("Invalid package entry");
  }
  rawEntry.enabled = params.enabled;
  writePackageRegistry(registry.registryPath, registry.registry);

  return {
    package: mutationItem(match.metadata, match.index, params.enabled),
    registryPath: registry.registryPath,
  };
}

export function getManagedModPackage(params: {
  modsRoot: string;
  specifier: string;
}): ManagedModPackageMutationResult {
  const registry = readMutablePackageRegistry(params.modsRoot);
  const match = findPackageIndex(
    params.modsRoot,
    registry.packagesValue,
    params.specifier,
  );

  return {
    package: mutationItem(match.metadata, match.index, match.metadata.enabled),
    registryPath: registry.registryPath,
  };
}

export function upsertManagedModPackage(params: {
  enabled?: boolean;
  entries: string[];
  modsRoot: string;
  source: string;
  version: string;
}): UpsertManagedModPackageResult {
  const rootRelativePath = getManagedModPackageRootRelativePathForSource(
    params.source,
  );
  if (!rootRelativePath) {
    throw new Error(`Invalid managed mod package source: ${params.source}`);
  }
  if (!params.version.trim()) {
    throw new Error("Package version must not be empty");
  }
  const entriesResult = validatePackageEntries(
    params.entries,
    "package.entries",
  );
  if (!entriesResult.ok) {
    throw new Error(
      entriesResult.diagnostics[0]?.error.message ?? "Invalid package entries",
    );
  }

  const registry = readMutablePackageRegistry(params.modsRoot, {
    createIfMissing: true,
  });
  validatePackageRegistryEntriesForMutation(
    params.modsRoot,
    registry.packagesValue,
  );

  const entry = {
    source: params.source,
    version: params.version,
    enabled: params.enabled ?? true,
    root: rootRelativePath,
    entries: entriesResult.entries,
  };
  const nextPackages: unknown[] = [];
  let insertionIndex = -1;
  let removedDuplicates = 0;
  let replaced = false;

  registry.packagesValue.forEach((rawEntry) => {
    if (isRecord(rawEntry) && rawEntry.source === params.source) {
      if (!replaced) {
        insertionIndex = nextPackages.length;
        nextPackages.push(entry);
        replaced = true;
      } else {
        removedDuplicates += 1;
      }
      return;
    }
    nextPackages.push(rawEntry);
  });

  if (!replaced) {
    insertionIndex = nextPackages.length;
    nextPackages.push(entry);
  }
  registry.registry.packages = nextPackages;
  writePackageRegistry(registry.registryPath, registry.registry);

  const metadata = getPackageMetadataForMutation(
    params.modsRoot,
    entry,
    insertionIndex,
  );
  return {
    package: mutationItem(metadata, insertionIndex, metadata.enabled),
    registryPath: registry.registryPath,
    removedDuplicates,
    replaced,
  };
}

export function removeManagedModPackage(params: {
  modsRoot: string;
  specifier: string;
}): ManagedModPackageMutationResult {
  const registry = readMutablePackageRegistry(params.modsRoot);
  const match = findPackageIndex(
    params.modsRoot,
    registry.packagesValue,
    params.specifier,
  );
  assertSafePackageRemovalRoot(match.metadata);
  registry.packagesValue.splice(match.index, 1);
  writePackageRegistry(registry.registryPath, registry.registry);
  rmSync(match.metadata.packageRoot, { force: true, recursive: true });

  return {
    package: mutationItem(match.metadata, match.index, match.metadata.enabled),
    registryPath: registry.registryPath,
    removedRoot: match.metadata.packageRoot,
  };
}
