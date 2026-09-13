import { readFileSync } from "node:fs";
import path from "node:path";
import { isModCapabilityId, type ModCapabilityId } from "@/mods/capabilities";
import { isModFileExtension } from "@/mods/file-extensions";

export const LETTA_PACKAGE_MANIFEST_VERSION = 1;

export type LettaPackageCapability = ModCapabilityId;

export interface LettaPackageEngines {
  lettaCodeCli?: string;
  lettaCodeDesktop?: string;
}

export interface LettaPackageManifest {
  manifestVersion: typeof LETTA_PACKAGE_MANIFEST_VERSION;
  mods: string[];
  capabilities?: LettaPackageCapability[];
  engines?: LettaPackageEngines;
}

export interface LettaPackageManifestValidationError {
  message: string;
  path: string;
}

export type LettaPackageManifestParseResult =
  | {
      errors: [];
      manifest: LettaPackageManifest | null;
      ok: true;
    }
  | {
      errors: LettaPackageManifestValidationError[];
      manifest: null;
      ok: false;
    };

const MANIFEST_KEYS = new Set([
  "manifestVersion",
  "mods",
  "capabilities",
  "engines",
]);
const ENGINE_KEYS = new Set(["lettaCodeCli", "lettaCodeDesktop"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(
  errors: LettaPackageManifestValidationError[],
  errorPath: string,
  message: string,
): void {
  errors.push({ message, path: errorPath });
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

export function isSafeLettaPackageModEntryPath(value: string): boolean {
  if (!value.trim()) return false;
  if (value.includes("\0")) return false;
  if (value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.isAbsolute(value)) return false;
  if (isWindowsAbsolutePath(value)) return false;

  const posixPath = value.replace(/\\/g, "/");
  if (posixPath.split("/").includes("..")) return false;
  const normalized = path.posix.normalize(posixPath);
  if (normalized === "." || normalized === "") return false;
  if (normalized === ".." || normalized.startsWith("../")) return false;
  if (normalized.split("/").includes("..")) return false;

  return isModFileExtension(path.posix.extname(normalized));
}

function isValidSemverIdentifier(value: string): boolean {
  return /^[0-9A-Za-z-]+$/.test(value);
}

function isValidSemverVersion(value: string): boolean {
  if (value === "*" || /^[xX]$/.test(value)) return true;

  const buildSeparatorIndex = value.indexOf("+");
  const versionWithPrerelease =
    buildSeparatorIndex >= 0 ? value.slice(0, buildSeparatorIndex) : value;
  const build =
    buildSeparatorIndex >= 0 ? value.slice(buildSeparatorIndex + 1) : undefined;
  if (build !== undefined) {
    if (!build || build.includes("+")) return false;
    const buildParts = build.split(".");
    if (buildParts.some((part) => !part || !isValidSemverIdentifier(part))) {
      return false;
    }
  }

  const prereleaseSeparatorIndex = versionWithPrerelease.indexOf("-");
  const version =
    prereleaseSeparatorIndex >= 0
      ? versionWithPrerelease.slice(0, prereleaseSeparatorIndex)
      : versionWithPrerelease;
  const prerelease =
    prereleaseSeparatorIndex >= 0
      ? versionWithPrerelease.slice(prereleaseSeparatorIndex + 1)
      : undefined;
  if (prerelease !== undefined) {
    if (!prerelease) return false;
    const prereleaseParts = prerelease.split(".");
    if (
      prereleaseParts.some((part) => !part || !isValidSemverIdentifier(part))
    ) {
      return false;
    }
  }

  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 3) return false;

  return parts.every((part) => {
    if (part === "*" || /^[xX]$/.test(part)) return true;
    return /^(0|[1-9]\d*)$/.test(part);
  });
}

function isValidSemverComparator(value: string): boolean {
  const match = value.match(/^(?:<=|>=|<|>|=|~\s*|\^\s*)?(.+)$/);
  const version = match?.[1]?.trim();
  if (!version) return false;
  return isValidSemverVersion(version);
}

function isValidSemverRange(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  return trimmed.split("||").every((part) => {
    const comparators = part.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every(isValidSemverComparator);
  });
}

function validateMods(
  value: unknown,
  errors: LettaPackageManifestValidationError[],
): string[] | null {
  if (!Array.isArray(value)) {
    addError(errors, "letta.mods", "mods must be a non-empty array");
    return null;
  }
  if (value.length === 0) {
    addError(errors, "letta.mods", "mods must include at least one entry");
    return null;
  }

  const mods: string[] = [];
  value.forEach((entry, index) => {
    const entryPath = `letta.mods[${index}]`;
    if (typeof entry !== "string") {
      addError(errors, entryPath, "mod entry must be a string path");
      return;
    }
    if (!isSafeLettaPackageModEntryPath(entry)) {
      addError(
        errors,
        entryPath,
        "mod entry must be a safe relative .ts, .tsx, .js, or .mjs path",
      );
      return;
    }
    mods.push(entry);
  });

  return mods;
}

function validateCapabilities(
  value: unknown,
  errors: LettaPackageManifestValidationError[],
): LettaPackageCapability[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addError(errors, "letta.capabilities", "capabilities must be an array");
    return undefined;
  }

  const capabilities: LettaPackageCapability[] = [];
  value.forEach((entry, index) => {
    const entryPath = `letta.capabilities[${index}]`;
    if (typeof entry !== "string") {
      addError(errors, entryPath, "capability must be a string");
      return;
    }
    if (!isModCapabilityId(entry)) {
      addError(errors, entryPath, `unknown capability '${entry}'`);
      return;
    }
    capabilities.push(entry);
  });

  return capabilities;
}

function validateEngines(
  value: unknown,
  errors: LettaPackageManifestValidationError[],
): LettaPackageEngines | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addError(errors, "letta.engines", "engines must be an object");
    return undefined;
  }

  for (const key of getUnknownKeys(value, ENGINE_KEYS)) {
    addError(errors, `letta.engines.${key}`, `unknown engine '${key}'`);
  }

  const engines: LettaPackageEngines = {};
  for (const key of ENGINE_KEYS) {
    const engineRange = value[key];
    if (engineRange === undefined) continue;
    if (typeof engineRange !== "string") {
      addError(errors, `letta.engines.${key}`, "engine range must be a string");
      continue;
    }
    if (!isValidSemverRange(engineRange)) {
      addError(
        errors,
        `letta.engines.${key}`,
        "engine range must be semver-compatible",
      );
      continue;
    }
    engines[key as keyof LettaPackageEngines] = engineRange;
  }

  return Object.keys(engines).length > 0 ? engines : undefined;
}

export function parseLettaPackageManifest(
  packageJson: unknown,
): LettaPackageManifestParseResult {
  if (!isRecord(packageJson)) {
    return {
      errors: [{ message: "package.json must be an object", path: "package" }],
      manifest: null,
      ok: false,
    };
  }

  const rawManifest = packageJson.letta;
  if (rawManifest === undefined) {
    return { errors: [], manifest: null, ok: true };
  }
  if (!isRecord(rawManifest)) {
    return {
      errors: [{ message: "letta manifest must be an object", path: "letta" }],
      manifest: null,
      ok: false,
    };
  }

  const errors: LettaPackageManifestValidationError[] = [];
  for (const key of getUnknownKeys(rawManifest, MANIFEST_KEYS)) {
    addError(errors, `letta.${key}`, `unknown manifest field '${key}'`);
  }

  if (rawManifest.manifestVersion !== LETTA_PACKAGE_MANIFEST_VERSION) {
    addError(
      errors,
      "letta.manifestVersion",
      `manifestVersion must be ${LETTA_PACKAGE_MANIFEST_VERSION}`,
    );
  }

  const mods = validateMods(rawManifest.mods, errors);
  const capabilities = validateCapabilities(rawManifest.capabilities, errors);
  const engines = validateEngines(rawManifest.engines, errors);

  if (errors.length > 0 || !mods) {
    return { errors, manifest: null, ok: false };
  }

  return {
    errors: [],
    manifest: {
      manifestVersion: LETTA_PACKAGE_MANIFEST_VERSION,
      mods,
      ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      ...(engines ? { engines } : {}),
    },
    ok: true,
  };
}

export function readLettaPackageManifest(
  packageJsonPath: string,
): LettaPackageManifestParseResult {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return parseLettaPackageManifest(packageJson);
  } catch (error) {
    return {
      errors: [
        {
          message: error instanceof Error ? error.message : String(error),
          path: packageJsonPath,
        },
      ],
      manifest: null,
      ok: false,
    };
  }
}
