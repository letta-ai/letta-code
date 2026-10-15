import { existsSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectPackageManager,
  type PackageManager,
} from "@/updater/auto-update";
import {
  getPackageManagerProcessFactory,
  type PackageManagerProcessFactory,
} from "@/utils/package-manager-spawn";
import { getChannelDir } from "./config";
import { getChannelPluginMetadata } from "./plugin-registry";
import type { SupportedChannelId } from "./types";

export const CHANNEL_RUNTIME_ROOT_ENV = "LETTA_CHANNEL_RUNTIME_ROOT";

type InstallProcessFactory = PackageManagerProcessFactory;
type RuntimePackageManager = PackageManager;

type RuntimeResolver = {
  runtimeDir: string;
  resolve: (moduleName: string) => string;
};

const PACKAGE_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function splitPackageSpecifier(moduleName: string): {
  packageName: string;
  exportKey: string;
} | null {
  const parts = moduleName.split("/");
  if (moduleName.startsWith("@")) {
    if (parts.length < 2) return null;
    const scope = parts[0]?.slice(1) ?? "";
    const name = parts[1] ?? "";
    if (!PACKAGE_NAME_SEGMENT.test(scope) || !PACKAGE_NAME_SEGMENT.test(name)) {
      return null;
    }
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      exportKey: parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".",
    };
  }
  if (!parts[0] || !PACKAGE_NAME_SEGMENT.test(parts[0])) return null;
  return {
    packageName: parts[0],
    exportKey: parts.length > 1 ? `./${parts.slice(1).join("/")}` : ".",
  };
}

function readImportExportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = readImportExportTarget(entry);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const conditions = value as Record<string, unknown>;
  for (const condition of ["import", "node", "default"]) {
    const target = readImportExportTarget(conditions[condition]);
    if (target) return target;
  }
  return null;
}

/** Resolve ESM-only packages whose exports omit the `require` condition. */
function resolveImportOnlyModulePath(
  runtimeDir: string,
  moduleName: string,
): string | null {
  const specifier = splitPackageSpecifier(moduleName);
  if (!specifier) return null;
  const packageRoot = join(
    runtimeDir,
    "node_modules",
    ...specifier.packageName.split("/"),
  );
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      exports?: unknown;
      module?: unknown;
      main?: unknown;
    };
    let exportValue: unknown;
    if (
      manifest.exports &&
      typeof manifest.exports === "object" &&
      !Array.isArray(manifest.exports)
    ) {
      const exportsMap = manifest.exports as Record<string, unknown>;
      const usesSubpathKeys = Object.keys(exportsMap).some((key) =>
        key.startsWith("."),
      );
      exportValue = usesSubpathKeys
        ? exportsMap[specifier.exportKey]
        : specifier.exportKey === "."
          ? manifest.exports
          : undefined;
    } else if (specifier.exportKey === ".") {
      exportValue = manifest.exports;
    }

    const target =
      readImportExportTarget(exportValue) ??
      (specifier.exportKey === "." && typeof manifest.module === "string"
        ? manifest.module
        : specifier.exportKey === "." && typeof manifest.main === "string"
          ? manifest.main
          : null);
    if (!target?.startsWith("./")) return null;
    const resolved = resolve(packageRoot, target);
    if (!resolved.startsWith(`${resolve(packageRoot)}${sep}`)) return null;
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

let spawnInstallProcessOverride: InstallProcessFactory | null = null;
let userRuntimeRootOverride: string | null = null;
let bundledRuntimeRootOverride: string | null | undefined;
let packageManagerOverride: RuntimePackageManager | null = null;
let platformOverride: NodeJS.Platform | null = null;

function getPackageDisplayName(packageSpec: string): string {
  if (!packageSpec.startsWith("@")) {
    return packageSpec.split("@")[0] || packageSpec;
  }

  const atIndex = packageSpec.lastIndexOf("@");
  return atIndex > 0 ? packageSpec.slice(0, atIndex) : packageSpec;
}

function getRuntimePackagePath(runtimeDir: string): string {
  return join(runtimeDir, "package.json");
}

export function getChannelRuntimeDir(channelId: SupportedChannelId): string {
  const parentDir = userRuntimeRootOverride ?? getChannelDir(channelId);
  return join(parentDir, "runtime");
}

export function getBundledChannelRuntimeDir(
  channelId: SupportedChannelId,
): string | null {
  const root =
    bundledRuntimeRootOverride !== undefined
      ? bundledRuntimeRootOverride
      : (process.env[CHANNEL_RUNTIME_ROOT_ENV] ?? null);
  if (!root) {
    return null;
  }
  return join(root, channelId, "runtime");
}

export function getChannelRuntimePackagePath(
  channelId: SupportedChannelId,
): string {
  return getRuntimePackagePath(getChannelRuntimeDir(channelId));
}

function getRuntimeResolvers(channelId: SupportedChannelId): RuntimeResolver[] {
  const resolvers: RuntimeResolver[] = [];
  const bundledRuntimeDir = getBundledChannelRuntimeDir(channelId);

  if (bundledRuntimeDir) {
    resolvers.push({
      runtimeDir: bundledRuntimeDir,
      resolve: (moduleName) =>
        createRequire(getRuntimePackagePath(bundledRuntimeDir)).resolve(
          moduleName,
        ),
    });
  }

  const userRuntimeDir = getChannelRuntimeDir(channelId);
  resolvers.push({
    runtimeDir: userRuntimeDir,
    resolve: (moduleName) =>
      createRequire(getRuntimePackagePath(userRuntimeDir)).resolve(moduleName),
  });

  return resolvers;
}

export function getChannelRuntimeSearchPaths(
  channelId: SupportedChannelId,
): string[] {
  return getRuntimeResolvers(channelId).map((resolver) => resolver.runtimeDir);
}

function resolveChannelRuntimeModulePath(
  channelId: SupportedChannelId,
  moduleName: string,
): string | null {
  for (const resolver of getRuntimeResolvers(channelId)) {
    try {
      return resolver.resolve(moduleName);
    } catch {
      const importOnlyPath = resolveImportOnlyModulePath(
        resolver.runtimeDir,
        moduleName,
      );
      if (importOnlyPath) return importOnlyPath;
    }
  }

  return null;
}

export function getChannelInstallCommand(
  channelId: SupportedChannelId,
): string {
  return `letta channels install ${channelId}`;
}

export function buildMissingChannelRuntimeError(
  channelId: SupportedChannelId,
): Error {
  const spec = getChannelPluginMetadata(channelId);
  return new Error(
    `${spec.displayName} support is not installed. Run: ${getChannelInstallCommand(channelId)} or start the listener with --install-channel-runtimes.`,
  );
}

export function isChannelRuntimeInstalled(
  channelId: SupportedChannelId,
): boolean {
  const spec = getChannelPluginMetadata(channelId);
  return spec.runtimeModules.every(
    (moduleName) =>
      resolveChannelRuntimeModulePath(channelId, moduleName) !== null,
  );
}

async function writeChannelRuntimeManifest(
  channelId: SupportedChannelId,
): Promise<void> {
  const runtimeDir = getChannelRuntimeDir(channelId);
  await mkdir(runtimeDir, { recursive: true });

  const manifest = {
    name: `letta-channel-runtime-${channelId}`,
    private: true,
    description: `Runtime dependencies for Letta Code ${channelId} channel support`,
  };

  await writeFile(
    getChannelRuntimePackagePath(channelId),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

async function linkUserPluginNodeModules(
  channelId: SupportedChannelId,
): Promise<void> {
  const spec = getChannelPluginMetadata(channelId);
  if (spec.firstParty) {
    return;
  }

  const runtimeNodeModules = join(
    getChannelRuntimeDir(channelId),
    "node_modules",
  );
  const channelNodeModules = join(getChannelDir(channelId), "node_modules");
  if (!existsSync(runtimeNodeModules) || existsSync(channelNodeModules)) {
    return;
  }

  try {
    await mkdir(getChannelDir(channelId), { recursive: true });
    await symlink(
      runtimeNodeModules,
      channelNodeModules,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // Best-effort convenience for ESM package resolution from plugin.mjs.
  }
}

function resolveInstallPackageManager(): RuntimePackageManager {
  return packageManagerOverride ?? detectPackageManager();
}

function getPackageManagerExecutable(
  packageManager: RuntimePackageManager,
): string {
  const platform = platformOverride ?? process.platform;
  if (platform === "win32" && packageManager !== "bun") {
    return `${packageManager}.cmd`;
  }
  return packageManager;
}

function resolveInstallPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}

function getInstallArgs(
  packageManager: RuntimePackageManager,
  installPackages: string[],
): string[] {
  // On Windows, npm/pnpm create .bin symlinks (junctions) that break
  // 7-Zip during Electron/NSIS packaging. --no-bin-links avoids this.
  const noBinLinks =
    resolveInstallPlatform() === "win32" && packageManager !== "bun";

  switch (packageManager) {
    case "bun":
      return ["add", "--no-save", ...installPackages];
    case "pnpm":
      return [
        "add",
        ...(noBinLinks ? ["--no-bin-links"] : []),
        ...installPackages,
      ];
    case "npm":
      return [
        "install",
        "--no-save",
        ...(noBinLinks ? ["--no-bin-links"] : []),
        ...installPackages,
      ];
  }
}

export async function installChannelRuntime(
  channelId: SupportedChannelId,
): Promise<void> {
  const spec = getChannelPluginMetadata(channelId);
  await writeChannelRuntimeManifest(channelId);

  const packageManager = resolveInstallPackageManager();
  const command = getPackageManagerExecutable(packageManager);
  const args = getInstallArgs(packageManager, spec.runtimePackages);
  const spawnInstallProcess =
    spawnInstallProcessOverride ??
    getPackageManagerProcessFactory({ platform: resolveInstallPlatform() });

  await new Promise<void>((resolve, reject) => {
    const proc = spawnInstallProcess(command, args, {
      cwd: getChannelRuntimeDir(channelId),
      stdio: "inherit",
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${packageManager} install failed with code ${code ?? "unknown"}`,
          ),
        );
      }
    });
  });

  await linkUserPluginNodeModules(channelId);
}

export async function ensureChannelRuntimeInstalled(
  channelId: SupportedChannelId,
): Promise<boolean> {
  if (isChannelRuntimeInstalled(channelId)) {
    return false;
  }

  const spec = getChannelPluginMetadata(channelId);
  const packageLabels = spec.runtimePackages.map((pkg) =>
    basename(getPackageDisplayName(pkg)),
  );
  console.log(
    `[Channels] Installing ${spec.displayName} runtime dependencies (${packageLabels.join(", ")})...`,
  );
  await installChannelRuntime(channelId);
  console.log(`[Channels] ${spec.displayName} runtime dependencies installed.`);
  return true;
}

export async function loadChannelRuntimeModule<T>(
  channelId: SupportedChannelId,
  moduleName?: string,
): Promise<T> {
  const spec = getChannelPluginMetadata(channelId);
  const targetModule = moduleName ?? spec.runtimeModules[0];
  if (!targetModule) {
    throw new Error(
      `No runtime module is configured for channel "${channelId}".`,
    );
  }

  const resolvedPath = resolveChannelRuntimeModulePath(channelId, targetModule);
  if (!resolvedPath) {
    throw buildMissingChannelRuntimeError(channelId);
  }

  return (await import(pathToFileURL(resolvedPath).href)) as T;
}

export function __testOverrideChannelRuntimeDeps(
  overrides: {
    runtimeRoot?: string | null;
    bundledRuntimeRoot?: string | null;
    spawnImpl?: InstallProcessFactory | null;
    packageManager?: RuntimePackageManager | null;
    platform?: NodeJS.Platform | null;
  } | null,
): void {
  userRuntimeRootOverride = overrides?.runtimeRoot ?? null;
  bundledRuntimeRootOverride = overrides
    ? (overrides.bundledRuntimeRoot ?? null)
    : undefined;
  spawnInstallProcessOverride = overrides?.spawnImpl ?? null;
  packageManagerOverride = overrides?.packageManager ?? null;
  platformOverride = overrides?.platform ?? null;
}
