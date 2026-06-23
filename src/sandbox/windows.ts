import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FsSandboxPolicy } from "./policy.js";

export const WINDOWS_SANDBOX_HELPER_NAME = "letta-windows-sandbox";
export const WINDOWS_SANDBOX_HELPER_EXE = `${WINDOWS_SANDBOX_HELPER_NAME}.exe`;
export const WINDOWS_SANDBOX_HELPER_ENV = "LETTA_WINDOWS_SANDBOX_HELPER";
export const WINDOWS_SANDBOX_BUILD_FROM_SOURCE_ENV =
  "LETTA_WINDOWS_SANDBOX_BUILD_FROM_SOURCE";

const WINDOWS_HELPER_SOURCE_RELATIVE_PATH = join(
  "native",
  "windows-sandbox",
  "LettaWindowsSandbox.cs",
);
const WINDOWS_HELPER_MANIFEST_RELATIVE_PATH = join(
  "native",
  "windows-sandbox",
  "LettaWindowsSandbox.manifest",
);

export interface WindowsSandboxDevBuildPaths {
  dir: string;
  sourcePath: string;
  exePath: string;
}

export type WindowsSandboxHelperResult =
  | { ok: true; helperPath: string; reason: string }
  | { ok: false; reason: string };

export interface WindowsSandboxHelperOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  validateHelper?: (
    helperPath: string,
    env: NodeJS.ProcessEnv,
  ) => WindowsSandboxHelperResult;
}

export function getWindowsSandboxPlatformTag(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  if (platform !== "win32") return null;
  if (arch === "x64" || arch === "arm64") return `win32-${arch}`;
  return null;
}

export function getPackagedWindowsSandboxHelperPath(
  options: {
    packageRoot?: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
  } = {},
): string | null {
  const tag = getWindowsSandboxPlatformTag(options.platform, options.arch);
  if (!tag) return null;
  return join(
    options.packageRoot ?? resolvePackageRoot(),
    "vendor",
    "windows-sandbox",
    tag,
    WINDOWS_SANDBOX_HELPER_EXE,
  );
}

export function getWindowsSandboxHelperSourcePath(
  packageRoot: string = resolvePackageRoot(),
): string {
  return join(packageRoot, WINDOWS_HELPER_SOURCE_RELATIVE_PATH);
}

export function getWindowsSandboxHelperManifestPath(
  packageRoot: string = resolvePackageRoot(),
): string {
  return join(packageRoot, WINDOWS_HELPER_MANIFEST_RELATIVE_PATH);
}

export function getWindowsSandboxDevBuildPaths(
  homeDir: string = homedir(),
  sourcePath: string = getWindowsSandboxHelperSourcePath(),
  sourceContent?: string,
): WindowsSandboxDevBuildPaths {
  const content = sourceContent ?? readFileSync(sourcePath, "utf8");
  const sourceHash = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);
  const dir = join(homeDir, ".letta", "sandbox", "windows");
  const stem = `${WINDOWS_SANDBOX_HELPER_NAME}-dev-${sourceHash}`;
  return {
    dir,
    sourcePath,
    exePath: join(dir, `${stem}.exe`),
  };
}

export function buildWindowsSandboxArgs(policy: FsSandboxPolicy): string[] {
  const args = ["--restrict-writes", policy.restrictWrites ? "1" : "0"];
  appendRoots(args, "--base-writable-root", policy.baseWritableRoots);
  appendRoots(args, "--denied-root", policy.deniedRoots);
  appendRoots(args, "--readonly-root", policy.readonlyRoots);
  appendRoots(args, "--writable-root", policy.writableRoots);
  return args;
}

export function ensureWindowsSandboxHelper(
  options: WindowsSandboxHelperOptions = {},
): WindowsSandboxHelperResult {
  const env = options.env ?? process.env;
  const validate = options.validateHelper ?? validateWindowsSandboxHelper;

  const explicitHelper = env[WINDOWS_SANDBOX_HELPER_ENV]?.trim();
  if (explicitHelper) {
    return validateResolvedHelper(
      explicitHelper,
      env,
      validate,
      `explicit ${WINDOWS_SANDBOX_HELPER_ENV}`,
    );
  }

  const packagedHelper = getPackagedWindowsSandboxHelperPath({
    packageRoot: options.packageRoot,
    platform: options.platform,
    arch: options.arch,
  });
  if (packagedHelper && existsSync(packagedHelper)) {
    return validateResolvedHelper(
      packagedHelper,
      env,
      validate,
      "packaged Windows sandbox helper",
    );
  }

  if (isTruthyEnv(env[WINDOWS_SANDBOX_BUILD_FROM_SOURCE_ENV])) {
    return ensureDevCompiledWindowsSandboxHelper(options, validate);
  }

  const expected = packagedHelper ?? "unsupported Windows architecture";
  return {
    ok: false,
    reason:
      `packaged Windows sandbox helper not found at ${expected}; ` +
      `install a release with the signed helper or set ${WINDOWS_SANDBOX_BUILD_FROM_SOURCE_ENV}=1 for a dev build`,
  };
}

function ensureDevCompiledWindowsSandboxHelper(
  options: WindowsSandboxHelperOptions,
  validate: (
    helperPath: string,
    env: NodeJS.ProcessEnv,
  ) => WindowsSandboxHelperResult,
): WindowsSandboxHelperResult {
  const env = options.env ?? process.env;
  const sourcePath = getWindowsSandboxHelperSourcePath(options.packageRoot);
  const manifestPath = getWindowsSandboxHelperManifestPath(options.packageRoot);

  try {
    if (!existsSync(sourcePath)) {
      return {
        ok: false,
        reason: `Windows sandbox helper source not found for dev build at ${sourcePath}`,
      };
    }
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        reason: `Windows sandbox helper manifest not found for dev build at ${manifestPath}`,
      };
    }

    const sourceContent = readFileSync(sourcePath, "utf8");
    const paths = getWindowsSandboxDevBuildPaths(
      options.homeDir,
      sourcePath,
      sourceContent,
    );
    mkdirSync(paths.dir, { recursive: true });

    if (existsSync(paths.exePath)) {
      return validateResolvedHelper(
        paths.exePath,
        env,
        validate,
        "dev-compiled Windows sandbox helper",
      );
    }

    const compiler = findCSharpCompiler(env);
    if (!compiler) {
      return {
        ok: false,
        reason:
          "no C# compiler found for Windows sandbox helper dev build (looked for csc.exe on PATH and in .NET Framework directories)",
      };
    }

    const platformArg = csharpPlatformArg(options.arch ?? process.arch);
    const result = spawnSync(
      compiler,
      [
        "/nologo",
        "/target:exe",
        `/platform:${platformArg}`,
        `/win32manifest:${manifestPath}`,
        `/out:${paths.exePath}`,
        paths.sourcePath,
      ],
      { encoding: "utf8", env },
    );
    if (result.error || result.status !== 0) {
      const detail = [result.error?.message, result.stderr, result.stdout]
        .filter(Boolean)
        .join("\n")
        .trim();
      return {
        ok: false,
        reason: `failed to compile Windows sandbox helper dev build with ${basename(compiler)}${
          detail ? `: ${detail}` : ""
        }`,
      };
    }

    const validated = validateResolvedHelper(
      paths.exePath,
      env,
      validate,
      "dev-compiled Windows sandbox helper",
    );
    if (!validated.ok) return validated;
    return {
      ok: true,
      helperPath: paths.exePath,
      reason: `Windows sandbox helper dev build compiled with ${basename(compiler)} and passed self-test`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateResolvedHelper(
  helperPath: string,
  env: NodeJS.ProcessEnv,
  validate: (
    helperPath: string,
    env: NodeJS.ProcessEnv,
  ) => WindowsSandboxHelperResult,
  label: string,
): WindowsSandboxHelperResult {
  if (!existsSync(helperPath)) {
    return { ok: false, reason: `${label} not found at ${helperPath}` };
  }

  const result = validate(helperPath, env);
  if (!result.ok) return result;
  return {
    ok: true,
    helperPath,
    reason: `${label} passed self-test`,
  };
}

export function validateWindowsSandboxHelper(
  helperPath: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsSandboxHelperResult {
  const base = mkTempSandboxDir();
  const denied = join(base, "victim");
  const readonly = join(denied, "readonly-self");
  const writable = join(denied, "writable-self");
  const allowed = join(base, "allowed");
  const blocked = join(base, "blocked");
  const secret = join(denied, "secret.txt");
  const readableSelf = join(readonly, "readable.txt");
  const writableSelf = join(writable, "writable.txt");
  const allowedOut = join(allowed, "ok.txt");
  const blockedOut = join(blocked, "bad.txt");

  try {
    mkdirSync(denied, { recursive: true });
    mkdirSync(readonly, { recursive: true });
    mkdirSync(writable, { recursive: true });
    mkdirSync(allowed, { recursive: true });
    mkdirSync(blocked, { recursive: true });
    writeFileSync(secret, "TOPSECRET", "utf8");
    writeFileSync(readableSelf, "READABLE", "utf8");
    writeFileSync(writableSelf, "WRITABLE", "utf8");

    const deny = spawnSync(
      helperPath,
      [
        "--restrict-writes",
        "0",
        "--denied-root",
        denied,
        "--",
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        `type "${secret}"`,
      ],
      { cwd: base, encoding: "utf8", env, timeout: 10_000 },
    );
    const deniedOutput = `${deny.stdout ?? ""}\n${deny.stderr ?? ""}`;
    if (deny.error || deny.status === 0 || deniedOutput.includes("TOPSECRET")) {
      return {
        ok: false,
        reason: `Windows sandbox helper self-test failed: denied root was readable${formatSpawnFailure(deny)}`,
      };
    }

    const readonlyCarve = spawnSync(
      helperPath,
      [
        "--restrict-writes",
        "0",
        "--denied-root",
        denied,
        "--readonly-root",
        readonly,
        "--",
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        `type "${readableSelf}"`,
      ],
      { cwd: base, encoding: "utf8", env, timeout: 10_000 },
    );
    if (
      readonlyCarve.error ||
      readonlyCarve.status !== 0 ||
      !readonlyCarve.stdout?.includes("READABLE")
    ) {
      return {
        ok: false,
        reason: `Windows sandbox helper self-test failed: readonly carveout was not readable${formatSpawnFailure(readonlyCarve)}`,
      };
    }

    const writableCarve = spawnSync(
      helperPath,
      [
        "--restrict-writes",
        "0",
        "--denied-root",
        denied,
        "--writable-root",
        writable,
        "--",
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        `echo ok > "${writableSelf}" && type "${writableSelf}"`,
      ],
      { cwd: base, encoding: "utf8", env, timeout: 10_000 },
    );
    if (
      writableCarve.error ||
      writableCarve.status !== 0 ||
      !writableCarve.stdout?.includes("ok")
    ) {
      return {
        ok: false,
        reason: `Windows sandbox helper self-test failed: writable carveout was not writable${formatSpawnFailure(writableCarve)}`,
      };
    }

    const write = spawnSync(
      helperPath,
      [
        "--restrict-writes",
        "1",
        "--writable-root",
        allowed,
        "--",
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        `echo ok > "${allowedOut}" && echo bad > "${blockedOut}"`,
      ],
      { cwd: base, encoding: "utf8", env, timeout: 10_000 },
    );
    if (write.error || write.status === 0 || existsSync(blockedOut)) {
      return {
        ok: false,
        reason: `Windows sandbox helper self-test failed: write restriction did not block outside root${formatSpawnFailure(write)}`,
      };
    }
    if (!existsSync(allowedOut)) {
      return {
        ok: false,
        reason:
          "Windows sandbox helper self-test failed: writable root was not writable",
      };
    }

    return {
      ok: true,
      helperPath,
      reason: "Windows sandbox helper passed self-test",
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export function findCSharpCompiler(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const names = ["csc.exe", "csc"];
  for (const dir of pathEntries(env)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const systemRoot =
    env.SystemRoot || env.SYSTEMROOT || env.WINDIR || "C:\\Windows";
  const frameworkRoots = [
    join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(systemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    join(systemRoot, "Microsoft.NET", "Framework64", "v4.8", "csc.exe"),
    join(systemRoot, "Microsoft.NET", "Framework", "v4.8", "csc.exe"),
  ];

  for (const candidate of frameworkRoots) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function appendRoots(args: string[], flag: string, roots: string[]): void {
  for (const root of roots) {
    args.push(flag, root);
  }
}

function mkTempSandboxDir(): string {
  const base = join(tmpdir(), `letta-windows-sandbox-${Date.now()}-`);
  let attempt = 0;
  while (true) {
    const candidate = `${base}${attempt}`;
    if (!existsSync(candidate)) {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    }
    attempt += 1;
  }
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  const parts = [
    result.error?.message,
    typeof result.status === "number" ? `exit ${result.status}` : undefined,
    result.stderr?.toString().trim(),
  ].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDelimiter = process.platform === "win32" ? ";" : delimiter;
  return raw.split(pathDelimiter).filter(Boolean);
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function csharpPlatformArg(arch: NodeJS.Architecture): string {
  if (arch === "x64") return "x64";
  // Not every inbox csc.exe supports /platform:arm64, and this helper is pure
  // managed C# plus P/Invoke declarations, so AnyCPU is the safest dev fallback.
  return "anycpu";
}

function resolvePackageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    moduleDir,
    dirname(moduleDir),
    dirname(dirname(moduleDir)),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }

  return process.cwd();
}
