import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, normalize } from "node:path";

const repoRoot = process.cwd();
const showConfigScript = join(
  repoRoot,
  "src",
  "skills",
  "builtin",
  "self-configuration",
  "scripts",
  "show_config.py",
);
const tempDirs: string[] = [];

const isolatedEnvKeys = [
  "AGENT_ID",
  "CONVERSATION_ID",
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
  "LETTA_SETTINGS_BASE_URL",
  "LETTA_BACKEND",
  "MEMORY_DIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

type FakeLettaVersion = {
  stdout?: string;
  stderr?: string;
  exitCode: number;
};

function expectPathSuffix(value: unknown, suffixParts: string[]): void {
  expect(typeof value).toBe("string");
  expect(
    normalize(value as string)
      .toLocaleLowerCase()
      .endsWith(join(...suffixParts).toLocaleLowerCase()),
  ).toBe(true);
}

function writeFakeLetta(binDir: string, version: FakeLettaVersion): string {
  mkdirSync(binDir, { recursive: true });
  const isWindows = process.platform === "win32";
  const executableName = isWindows ? "letta.cmd" : "letta";
  const lettaPath = join(binDir, executableName);
  if (isWindows) {
    const versionLines = [
      "@echo off",
      'if "%~1"=="--version" (',
      ...(version.stdout ? [`  echo ${version.stdout}`] : []),
      ...(version.stderr ? [`  echo ${version.stderr} 1>&2`] : []),
      `  exit /b ${version.exitCode}`,
      ")",
      "echo unexpected command %~1 1>&2",
      "exit /b 42",
      "",
    ];
    writeFileSync(lettaPath, versionLines.join("\r\n"), "utf8");
    return lettaPath;
  }

  const stdoutLine = version.stdout
    ? `printf ${JSON.stringify(`${version.stdout}\n`)}`
    : "";
  const stderrLine = version.stderr
    ? `printf ${JSON.stringify(`${version.stderr}\n`)} >&2`
    : "";
  writeFileSync(
    lettaPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  ${stdoutLine}
  ${stderrLine}
  exit ${version.exitCode}
fi
printf "unexpected command %s\\n" "$1" >&2
exit 42
`,
    "utf8",
  );
  chmodSync(lettaPath, 0o755);
  return lettaPath;
}

async function runShowConfig(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const key of isolatedEnvKeys) delete childEnv[key];
  Object.assign(childEnv, env);
  if (env.HOME !== undefined && env.USERPROFILE === undefined) {
    childEnv.USERPROFILE = env.HOME;
  }

  const proc = Bun.spawn({
    cmd: ["python3", showConfigScript, ...args],
    cwd: repoRoot,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

test("show_config runtime reports safe process and settings facts", async () => {
  const root = makeTempDir("self-config-show-config-");
  const homeDir = join(root, "home");
  const cwd = join(root, "project");
  const binDir = join(root, "bin");
  const memoryDir = join(root, "memory");
  const lettaPath = writeFakeLetta(binDir, {
    stdout: "letta-code 9.9.9",
    exitCode: 0,
  });

  mkdirSync(cwd, { recursive: true });
  writeJson(join(homeDir, ".letta", "settings.json"), {
    preferredBackendMode: "api",
    env: {
      LETTA_API_KEY: "settings-secret",
      LETTA_BASE_URL: "https://settings-base.example",
      LETTA_BACKEND: "api",
    },
  });
  writeJson(join(cwd, ".letta", "settings.local.json"), {
    preferredBackendMode: "local",
    env: {
      LETTA_SETTINGS_BASE_URL: "https://settings-scope.example",
    },
  });

  const result = await runShowConfig(
    ["--cwd", cwd, "--section", "runtime", "--json"],
    {
      HOME: homeDir,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      AGENT_ID: "agent-test",
      CONVERSATION_ID: "conv-test",
      LETTA_API_KEY: "runtime-secret",
      LETTA_BASE_URL: "https://runtime-base.example",
      LETTA_BACKEND: "local",
      MEMORY_DIR: memoryDir,
    },
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const output = parseJsonOutput(result.stdout);
  const runtime = output.runtime as Record<string, unknown>;
  expect(runtime).toMatchObject({
    letta_version: "letta-code 9.9.9",
    saved_backend: "local",
    agent_id: "agent-test",
    conversation_id: "conv-test",
    base_url: "https://runtime-base.example",
    settings_base_url: "https://settings-scope.example",
    backend_env: "local",
    api_key_present: true,
    memory_dir: memoryDir,
  });
  expectPathSuffix(runtime.cwd, [basename(root), "project"]);
  expectPathSuffix(runtime.letta_binary, [
    basename(root),
    "bin",
    basename(lettaPath),
  ]);
  expect(result.stdout).not.toContain("runtime-secret");
  expect(result.stdout).not.toContain("settings-secret");
});

test("show_config json agents omit arbitrary agent entry fields", async () => {
  const root = makeTempDir("self-config-show-config-agents-");
  const homeDir = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  writeJson(join(homeDir, ".letta", "settings.json"), {
    agents: [
      {
        agentId: "agent-test",
        baseUrl: "https://api.letta.com",
        pinned: true,
        memfs: false,
        toolset: "auto",
        systemPromptHash: "safe-hash",
        apiKey: "settings-secret",
        token: "settings-token",
        customField: "custom-value",
      },
    ],
  });

  const result = await runShowConfig(
    ["--cwd", cwd, "--section", "agents", "--json"],
    { HOME: homeDir },
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const output = parseJsonOutput(result.stdout);
  expect(output.agents).toEqual([
    {
      scope: "user",
      agentId: "agent-test",
      baseUrl: "https://api.letta.com",
      pinned: true,
      memfs: false,
      toolset: "auto",
      systemPromptHash: "safe-hash",
    },
  ]);
  expect(result.stdout).not.toContain("settings-secret");
  expect(result.stdout).not.toContain("settings-token");
  expect(result.stdout).not.toContain("custom-value");
  expect(result.stdout).not.toContain("customField");
});

test("show_config runtime represents letta version failures safely", async () => {
  const root = makeTempDir("self-config-show-config-failure-");
  const homeDir = join(root, "home");
  const cwd = join(root, "project");
  const binDir = join(root, "bin");
  writeFakeLetta(binDir, {
    stderr: "broken version check",
    exitCode: 7,
  });

  mkdirSync(cwd, { recursive: true });
  const result = await runShowConfig(
    ["--cwd", cwd, "--section", "runtime", "--json"],
    {
      HOME: homeDir,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const output = parseJsonOutput(result.stdout);
  expect(output.runtime).toMatchObject({
    letta_version: "<failed exit 7: broken version check>",
    api_key_present: false,
  });
});
