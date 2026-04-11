import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectPackageManager,
  type PackageManager,
} from "../updater/auto-update";
import { getChannelDir } from "./config";
import { getChannelPluginMetadata } from "./pluginRegistry";
import type { SupportedChannelId } from "./types";

export const CHANNEL_RUNTIME_ROOT_ENV = "LETTA_CHANNEL_RUNTIME_ROOT";

type InstallProcessFactory = typeof spawn;
type RuntimePackageManager = PackageManager;

type RuntimeResolver = {
  runtimeDir: string;
  resolve: (moduleName: string) => string;
};

let spawnInstallProcess: InstallProcessFactory = spawn;
let userRuntimeRootOverride: string | null = null;
let bundledRuntimeRootOverride: string | null = null;
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
    bundledRuntimeRootOverride ?? process.env[CHANNEL_RUNTIME_ROOT_ENV] ?? null;
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
      // Try next resolver.
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

function getInstallArgs(
  packageManager: RuntimePackageManager,
  installPackages: string[],
): string[] {
  switch (packageManager) {
    case "bun":
      return ["add", "--no-save", ...installPackages];
    case "pnpm":
      return ["add", ...installPackages];
    case "npm":
      return ["install", "--no-save", ...installPackages];
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
  bundledRuntimeRootOverride = overrides?.bundledRuntimeRoot ?? null;
  spawnInstallProcess = overrides?.spawnImpl ?? spawn;
  packageManagerOverride = overrides?.packageManager ?? null;
  platformOverride = overrides?.platform ?? null;
}
