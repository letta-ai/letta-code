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
import type { SupportedChannelId } from "./types";

type ChannelRuntimeSpec = {
  displayName: string;
  installPackages: string[];
  loadModule: string;
};

const CHANNEL_RUNTIME_SPECS: Record<SupportedChannelId, ChannelRuntimeSpec> = {
  telegram: {
    displayName: "Telegram",
    installPackages: ["grammy@1.42.0"],
    loadModule: "grammy",
  },
};

type InstallProcessFactory = typeof spawn;
type RuntimePackageManager = PackageManager;

let spawnInstallProcess: InstallProcessFactory = spawn;
let runtimeRootOverride: string | null = null;
let packageManagerOverride: RuntimePackageManager | null = null;
let platformOverride: NodeJS.Platform | null = null;

function getChannelRuntimeSpec(
  channelId: SupportedChannelId,
): ChannelRuntimeSpec {
  return CHANNEL_RUNTIME_SPECS[channelId];
}

function getPackageDisplayName(packageSpec: string): string {
  if (!packageSpec.startsWith("@")) {
    return packageSpec.split("@")[0] || packageSpec;
  }

  const atIndex = packageSpec.lastIndexOf("@");
  return atIndex > 0 ? packageSpec.slice(0, atIndex) : packageSpec;
}

export function getChannelRuntimeDir(channelId: SupportedChannelId): string {
  const parentDir = runtimeRootOverride ?? getChannelDir(channelId);
  return join(parentDir, "runtime");
}

export function getChannelRuntimePackagePath(
  channelId: SupportedChannelId,
): string {
  return join(getChannelRuntimeDir(channelId), "package.json");
}

function getChannelRuntimeRequire(channelId: SupportedChannelId) {
  return createRequire(getChannelRuntimePackagePath(channelId));
}

export function getChannelInstallCommand(
  channelId: SupportedChannelId,
): string {
  return `letta channels install ${channelId}`;
}

export function buildMissingChannelRuntimeError(
  channelId: SupportedChannelId,
): Error {
  const spec = getChannelRuntimeSpec(channelId);
  return new Error(
    `${spec.displayName} support is not installed. Run: ${getChannelInstallCommand(channelId)}`,
  );
}

export function isChannelRuntimeInstalled(
  channelId: SupportedChannelId,
): boolean {
  const spec = getChannelRuntimeSpec(channelId);
  try {
    getChannelRuntimeRequire(channelId).resolve(spec.loadModule);
    return true;
  } catch {
    return false;
  }
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
  const spec = getChannelRuntimeSpec(channelId);
  await writeChannelRuntimeManifest(channelId);

  const packageManager = resolveInstallPackageManager();
  const command = getPackageManagerExecutable(packageManager);
  const args = getInstallArgs(packageManager, spec.installPackages);

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

  const spec = getChannelRuntimeSpec(channelId);
  const packageLabels = spec.installPackages.map((pkg) =>
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
): Promise<T> {
  const spec = getChannelRuntimeSpec(channelId);

  let resolvedPath: string;
  try {
    resolvedPath = getChannelRuntimeRequire(channelId).resolve(spec.loadModule);
  } catch {
    throw buildMissingChannelRuntimeError(channelId);
  }

  return (await import(pathToFileURL(resolvedPath).href)) as T;
}

export function __testOverrideChannelRuntimeDeps(
  overrides: {
    runtimeRoot?: string | null;
    spawnImpl?: InstallProcessFactory | null;
    packageManager?: RuntimePackageManager | null;
    platform?: NodeJS.Platform | null;
  } | null,
): void {
  runtimeRootOverride = overrides?.runtimeRoot ?? null;
  spawnInstallProcess = overrides?.spawnImpl ?? spawn;
  packageManagerOverride = overrides?.packageManager ?? null;
  platformOverride = overrides?.platform ?? null;
}
