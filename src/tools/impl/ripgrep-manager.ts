import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, homedir, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const TOOLS_DIR_ENV = "LETTA_CODE_TOOLS_DIR";
const OFFLINE_ENV = "LETTA_CODE_OFFLINE";
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const APP_USER_AGENT = "letta-code";

interface ToolConfig {
  name: string;
  repo: string;
  binaryName: string;
  systemBinaryNames?: string[];
  tagPrefix: string;
  getAssetName: (
    version: string,
    plat: NodeJS.Platform,
    architecture: string,
  ) => string | null;
}

const RIPGREP_CONFIG: ToolConfig = {
  name: "ripgrep",
  repo: "BurntSushi/ripgrep",
  binaryName: "rg",
  tagPrefix: "",
  getAssetName: (version, plat, architecture) => {
    if (plat === "darwin") {
      const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
      return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
    }
    if (plat === "linux") {
      if (architecture === "arm64") {
        return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
      }
      return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
    }
    if (plat === "win32") {
      const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
      return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
    }
    return null;
  },
};

function isOfflineModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[OFFLINE_ENV];
  if (!value) return false;
  return (
    value === "1" ||
    value.toLowerCase() === "true" ||
    value.toLowerCase() === "yes"
  );
}

export function getManagedToolsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[TOOLS_DIR_ENV] || join(homedir(), ".letta", "bin");
}

function binaryName(config: ToolConfig): string {
  return config.binaryName + (platform() === "win32" ? ".exe" : "");
}

function commandWorks(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const result = spawnSync(command, ["--version"], { env, stdio: "pipe" });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function getBundledRipgrepPath(): string | null {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    const rgPackage = require("@vscode/ripgrep") as { rgPath?: unknown };
    return typeof rgPackage.rgPath === "string" ? rgPackage.rgPath : null;
  } catch {
    return null;
  }
}

interface RipgrepPathOptions {
  env?: NodeJS.ProcessEnv;
}

export function getRipgrepPath(
  options: RipgrepPathOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const config = RIPGREP_CONFIG;
  const managedPath = join(getManagedToolsDir(env), binaryName(config));
  if (existsSync(managedPath) && commandWorks(managedPath, env)) {
    return managedPath;
  }

  const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
  for (const systemBinaryName of systemBinaryNames) {
    if (commandWorks(systemBinaryName, env)) {
      return systemBinaryName;
    }
  }

  const bundledPath = getBundledRipgrepPath();
  if (
    bundledPath &&
    existsSync(bundledPath) &&
    commandWorks(bundledPath, env)
  ) {
    return bundledPath;
  }

  return null;
}

async function getLatestVersion(repo: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: { "User-Agent": APP_USER_AGENT },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = (await response.json()) as { tag_name: string };
  return data.tag_name.replace(/^v/, "");
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const fileStream = createWriteStream(dest);
  await pipeline(Readable.fromWeb(response.body as never), fileStream);
}

function findBinaryRecursively(
  rootDir: string,
  binaryFileName: string,
): string | null {
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryFileName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }

  return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
  if (result.error?.message) {
    return result.error.message;
  }
  const stderr = result.stderr?.toString().trim();
  if (stderr) {
    return stderr;
  }
  const stdout = result.stdout?.toString().trim();
  if (stdout) {
    return stdout;
  }
  return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (!result.error && result.status === 0) {
    return null;
  }
  return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(
  archivePath: string,
  extractDir: string,
  assetName: string,
): void {
  const failure = runExtractionCommand("tar", [
    "xzf",
    archivePath,
    "-C",
    extractDir,
  ]);
  if (failure) {
    throw new Error(`Failed to extract ${assetName}: ${failure}`);
  }
}

function getWindowsTarCommand(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot) {
    const systemTar = join(systemRoot, "System32", "tar.exe");
    if (existsSync(systemTar)) {
      return systemTar;
    }
  }
  return "tar.exe";
}

function extractZipArchive(
  archivePath: string,
  extractDir: string,
  assetName: string,
): void {
  const failures: string[] = [];

  if (platform() === "win32") {
    const tarFailure = runExtractionCommand(getWindowsTarCommand(), [
      "xf",
      archivePath,
      "-C",
      extractDir,
    ]);
    if (!tarFailure) return;
    failures.push(tarFailure);

    const script =
      "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const powershellFailure = runExtractionCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      archivePath,
      extractDir,
    ]);
    if (!powershellFailure) return;
    failures.push(powershellFailure);
  } else {
    const unzipFailure = runExtractionCommand("unzip", [
      "-q",
      archivePath,
      "-d",
      extractDir,
    ]);
    if (!unzipFailure) return;
    failures.push(unzipFailure);

    const tarFailure = runExtractionCommand("tar", [
      "xf",
      archivePath,
      "-C",
      extractDir,
    ]);
    if (!tarFailure) return;
    failures.push(tarFailure);
  }

  throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

async function downloadRipgrep(): Promise<string> {
  const config = RIPGREP_CONFIG;
  const plat = platform();
  const architecture = arch();
  const version = await getLatestVersion(config.repo);
  const assetName = config.getAssetName(version, plat, architecture);
  if (!assetName) {
    throw new Error(`Unsupported platform: ${plat}/${architecture}`);
  }

  const toolsDir = getManagedToolsDir();
  mkdirSync(toolsDir, { recursive: true });

  const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
  const archivePath = join(toolsDir, assetName);
  const binaryFileName = binaryName(config);
  const binaryPath = join(toolsDir, binaryFileName);

  await downloadFile(downloadUrl, archivePath);

  const extractDir = join(
    toolsDir,
    `extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(extractDir, { recursive: true });

  try {
    if (assetName.endsWith(".tar.gz")) {
      extractTarGzArchive(archivePath, extractDir, assetName);
    } else if (assetName.endsWith(".zip")) {
      extractZipArchive(archivePath, extractDir, assetName);
    } else {
      throw new Error(`Unsupported archive format: ${assetName}`);
    }

    const extractedDir = join(
      extractDir,
      assetName.replace(/\.(tar\.gz|zip)$/, ""),
    );
    const extractedBinaryCandidates = [
      join(extractedDir, binaryFileName),
      join(extractDir, binaryFileName),
    ];
    let extractedBinary = extractedBinaryCandidates.find((candidate) =>
      existsSync(candidate),
    );
    if (!extractedBinary) {
      extractedBinary =
        findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
    }

    if (!extractedBinary) {
      throw new Error(
        `Binary not found in archive: expected ${binaryFileName} under ${extractDir}`,
      );
    }

    renameSync(extractedBinary, binaryPath);
    if (plat !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }

  if (!commandWorks(binaryPath)) {
    throw new Error(
      `${config.name} installed to ${binaryPath} but failed --version validation`,
    );
  }

  return binaryPath;
}

export async function ensureRipgrep(
  silent = false,
): Promise<string | undefined> {
  const existingPath = getRipgrepPath();
  if (existingPath) {
    return existingPath;
  }

  if (isOfflineModeEnabled()) {
    if (!silent) {
      console.warn(
        "ripgrep not found. Offline mode enabled, skipping download.",
      );
    }
    return undefined;
  }

  if (platform() === "android") {
    if (!silent) {
      console.warn("ripgrep not found. Install with: pkg install ripgrep");
    }
    return undefined;
  }

  if (!silent) {
    console.log("ripgrep not found. Downloading...");
  }

  try {
    const path = await downloadRipgrep();
    if (!silent) {
      console.log(`ripgrep installed to ${path}`);
    }
    return path;
  } catch (error) {
    if (!silent) {
      console.warn(
        `Failed to download ripgrep: ${error instanceof Error ? error.message : error}`,
      );
    }
    return undefined;
  }
}

export function getRipgrepBinDir(
  options: RipgrepPathOptions = {},
): string | undefined {
  const rgPath = getRipgrepPath(options);
  if (!rgPath || !isAbsolute(rgPath)) return undefined;
  return dirname(rgPath);
}
