import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  isSafeLettaPackageModEntryPath,
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

  if (
    diagnostics.length > 0 ||
    typeof source !== "string" ||
    typeof version !== "string" ||
    typeof enabled !== "boolean"
  ) {
    return { diagnostics, ok: false };
  }

  if (enabled === false) {
    return { diagnostics: [], files: [], ok: true, packageSource: null };
  }

  if (typeof rawEntry.root !== "string") {
    return {
      diagnostics: [
        createDiagnostic(
          `${diagnosticPath}.root`,
          "package root must be a string",
        ),
      ],
      ok: false,
    };
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

  const packageJsonPath = path.join(packageRoot, "package.json");
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
  for (const entry of entriesResult.entries) {
    const normalizedEntry = normalizeModEntry(entry);
    if (!manifestEntries.has(normalizedEntry)) {
      diagnostics.push(
        createDiagnostic(
          `${diagnosticPath}.entries`,
          `Package entry '${entry}' is not declared in package.json#letta.mods`,
        ),
      );
      continue;
    }
    const entryPath = resolvePackageEntry(packageRoot, normalizedEntry);
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
    files,
    ok: true,
    packageSource: {
      entries: entriesResult.entries,
      files,
      root: packageRoot,
      source,
      version,
    },
  };
}

export function resolveManagedModPackages(
  modsRoot: string,
): ResolveManagedModPackagesResult {
  const registryPath = path.join(modsRoot, MOD_PACKAGES_REGISTRY_FILENAME);
  if (!existsSync(registryPath)) {
    return { diagnostics: [], files: [], packages: [] };
  }

  const registryResult = parseJsonFile(registryPath);
  if (!registryResult.ok) {
    return { diagnostics: [registryResult.error], files: [], packages: [] };
  }
  if (!isRecord(registryResult.value)) {
    return {
      diagnostics: [
        createDiagnostic(registryPath, "packages.json must be an object"),
      ],
      files: [],
      packages: [],
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
    return { diagnostics, files: [], packages: [] };
  }

  const files: string[] = [];
  const packages: ManagedModPackageSource[] = [];
  packagesValue.forEach((entry, index) => {
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
