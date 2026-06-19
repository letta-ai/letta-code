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
import { basename, delimiter, join } from "node:path";
import type { FsSandboxPolicy } from "./policy.js";
import { WINDOWS_SANDBOX_HELPER_SOURCE } from "./windows-helper-source.js";

export const WINDOWS_SANDBOX_HELPER_NAME = "letta-windows-sandbox";

const SOURCE_HASH = createHash("sha256")
  .update(WINDOWS_SANDBOX_HELPER_SOURCE)
  .digest("hex")
  .slice(0, 16);

export interface WindowsSandboxHelperPaths {
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
}

export function getWindowsSandboxHelperPaths(
  homeDir: string = homedir(),
): WindowsSandboxHelperPaths {
  const dir = join(homeDir, ".letta", "sandbox", "windows");
  const stem = `${WINDOWS_SANDBOX_HELPER_NAME}-${SOURCE_HASH}`;
  return {
    dir,
    sourcePath: join(dir, `${stem}.cs`),
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
  const paths = getWindowsSandboxHelperPaths(options.homeDir);

  try {
    mkdirSync(paths.dir, { recursive: true });
    writeSourceIfChanged(paths.sourcePath);

    if (existsSync(paths.exePath)) {
      return validateWindowsSandboxHelper(paths.exePath, env);
    }

    const compiler = findCSharpCompiler(env);
    if (!compiler) {
      return {
        ok: false,
        reason:
          "no C# compiler found (looked for csc.exe on PATH and in .NET Framework directories)",
      };
    }

    const result = spawnSync(
      compiler,
      ["/nologo", "/target:exe", `/out:${paths.exePath}`, paths.sourcePath],
      { encoding: "utf8", env },
    );
    if (result.error || result.status !== 0) {
      const detail = [result.error?.message, result.stderr, result.stdout]
        .filter(Boolean)
        .join("\n")
        .trim();
      return {
        ok: false,
        reason: `failed to compile Windows sandbox helper with ${basename(compiler)}${
          detail ? `: ${detail}` : ""
        }`,
      };
    }

    const validated = validateWindowsSandboxHelper(paths.exePath, env);
    if (!validated.ok) return validated;
    return {
      ok: true,
      helperPath: paths.exePath,
      reason: `Windows sandbox helper compiled with ${basename(compiler)} and passed self-test`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateWindowsSandboxHelper(
  helperPath: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsSandboxHelperResult {
  const base = mkTempSandboxDir();
  const denied = join(base, "victim");
  const allowed = join(base, "allowed");
  const blocked = join(base, "blocked");
  const secret = join(denied, "secret.txt");
  const allowedOut = join(allowed, "ok.txt");
  const blockedOut = join(blocked, "bad.txt");

  try {
    mkdirSync(denied, { recursive: true });
    mkdirSync(allowed, { recursive: true });
    mkdirSync(blocked, { recursive: true });
    writeFileSync(secret, "TOPSECRET", "utf8");

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

function writeSourceIfChanged(sourcePath: string): void {
  if (existsSync(sourcePath)) {
    const current = readFileSync(sourcePath, "utf8");
    if (current === WINDOWS_SANDBOX_HELPER_SOURCE) return;
  }
  writeFileSync(sourcePath, WINDOWS_SANDBOX_HELPER_SOURCE, "utf8");
}
