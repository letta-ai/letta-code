import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Mode = "manual" | "startup";

type Args = {
  mode: Mode;
};

const PROJECT_ROOT = process.cwd();
const PACKAGE_NAME = "@letta-ai/letta-code";
const OLD_VERSION = "0.0.1";
const NEW_VERSION = "0.0.2";
const REGISTRY_PORT = 4873;
const REGISTRY_URL = `http://127.0.0.1:${REGISTRY_PORT}`;
const VERDACCIO_IMAGE = "verdaccio/verdaccio:5";
const REGISTRY_USER = "ci-user";
const REGISTRY_PASS = "ci-pass";
const REGISTRY_EMAIL = "ci@example.com";

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "manual" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--mode") {
      const next = argv[++i] as Mode | undefined;
      if (next === "manual" || next === "startup") {
        args.mode = next;
      } else {
        throw new Error(`Invalid --mode value: ${next}`);
      }
    }
  }
  return args;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSemver(text: string): string {
  const match = text.match(/\b\d+\.\d+\.\d+\b/);
  if (!match) {
    throw new Error(`Could not parse semantic version from: ${text}`);
  }
  return match[0];
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    expectExit?: number;
    stdin?: string;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const {
    cwd = PROJECT_ROOT,
    env = process.env,
    timeoutMs = 180000,
    expectExit = 0,
    stdin,
  } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      shell: false,
    });

    if (typeof stdin === "string") {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    }

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    proc.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (typeof expectExit === "number" && exitCode !== expectExit) {
        reject(
          new Error(
            `Unexpected exit ${exitCode}: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForVerdaccio(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${REGISTRY_URL}/-/ping`, {
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) return;
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Verdaccio at ${REGISTRY_URL}`);
}

function writePermissiveVerdaccioConfig(configPath: string) {
  const config = `storage: /verdaccio/storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@*/*':
    access: $all
    publish: $all
    unpublish: $all
    proxy: npmjs
  '**':
    access: $all
    publish: $all
    unpublish: $all
    proxy: npmjs
auth:
  htpasswd:
    file: /verdaccio/storage/htpasswd
    max_users: -1
server:
  keepAliveTimeout: 60
logs:
  - { type: stdout, format: pretty, level: http }
`;
  writeFileSync(configPath, config, "utf8");
}

function setVersionInPackageJson(packageJsonPath: string, version: string) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version: string;
  };
  packageJson.version = version;
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
}

async function buildAndPackVersion(
  workspaceDir: string,
  version: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const packageJsonPath = join(workspaceDir, "package.json");
  setVersionInPackageJson(packageJsonPath, version);

  const packageLockPath = join(workspaceDir, "package-lock.json");
  setVersionInPackageJson(packageLockPath, version);

  await runCommand("bun", ["run", "build"], {
    cwd: workspaceDir,
    env,
    timeoutMs: 300000,
  });

  const packResult = await runCommand("npm", ["pack", "--json"], {
    cwd: workspaceDir,
    env,
  });

  const packed = JSON.parse(packResult.stdout) as Array<{ filename: string }>;
  const tarballName = packed[0]?.filename;
  if (!tarballName) {
    throw new Error(`npm pack did not return filename: ${packResult.stdout}`);
  }

  const sourceTarball = join(workspaceDir, tarballName);
  const targetTarball = join(workspaceDir, `letta-code-${version}.tgz`);
  renameSync(sourceTarball, targetTarball);
  return targetTarball;
}

async function authenticateToRegistry(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(
    "npm",
    ["adduser", "--registry", REGISTRY_URL, "--auth-type", "legacy"],
    {
      env,
      timeoutMs: 60000,
      stdin: `${REGISTRY_USER}\n${REGISTRY_PASS}\n${REGISTRY_EMAIL}\n`,
    },
  );
}

async function publishTarball(
  tarballPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runCommand(
    "npm",
    ["publish", tarballPath, "--registry", REGISTRY_URL, "--access", "public"],
    { env, timeoutMs: 180000 },
  );
}

async function getGlobalBinDir(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand("npm", ["prefix", "-g"], { env });
  return `${result.stdout.trim()}/bin`;
}

async function getInstalledVersion(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand("letta", ["--version"], { env });
  return extractSemver(result.stdout.trim());
}

async function prepareWorkspace(
  baseEnv: NodeJS.ProcessEnv,
  workspaceDir: string,
) {
  await runCommand(
    "git",
    ["clone", "--depth", "1", PROJECT_ROOT, workspaceDir],
    {
      env: baseEnv,
      timeoutMs: 240000,
    },
  );

  await runCommand("bun", ["install"], {
    cwd: workspaceDir,
    env: baseEnv,
    timeoutMs: 240000,
  });
}

async function runManualUpdateFlow(env: NodeJS.ProcessEnv) {
  const versionBefore = await getInstalledVersion(env);
  if (versionBefore !== OLD_VERSION) {
    throw new Error(
      `Expected pre-update version ${OLD_VERSION}, got ${versionBefore}`,
    );
  }

  await runCommand("letta", ["update"], {
    env: {
      ...env,
      DISABLE_AUTOUPDATER: "1",
    },
    timeoutMs: 180000,
  });

  const versionAfter = await getInstalledVersion(env);
  if (versionAfter !== NEW_VERSION) {
    throw new Error(
      `Expected post-update version ${NEW_VERSION}, got ${versionAfter}`,
    );
  }
}

async function runStartupUpdateFlow(env: NodeJS.ProcessEnv) {
  const versionBefore = await getInstalledVersion(env);
  if (versionBefore !== OLD_VERSION) {
    throw new Error(
      `Expected pre-startup version ${OLD_VERSION}, got ${versionBefore}`,
    );
  }

  const maxAttempts = 15;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await runCommand("letta", ["--help"], {
      env: {
        ...env,
        LETTA_TEST_HELP_EXIT_DELAY_MS: "3000",
      },
      timeoutMs: 120000,
    });

    const current = await getInstalledVersion(env);
    if (current === NEW_VERSION) {
      return;
    }

    await sleep(1500);
  }

  const finalVersion = await getInstalledVersion(env);
  throw new Error(
    `Startup auto-update did not converge to ${NEW_VERSION}; final version ${finalVersion}`,
  );
}

async function main() {
  const { mode } = parseArgs(process.argv.slice(2));

  if (process.platform !== "linux") {
    console.log(
      "SKIP: update-chain smoke currently targets Linux runners only",
    );
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "letta-update-chain-"));
  const workspaceDir = join(tempRoot, "workspace");
  const npmPrefix = join(tempRoot, "npm-prefix");
  const npmCache = join(tempRoot, "npm-cache");
  const npmUserConfig = join(tempRoot, ".npmrc");
  const verdaccioConfigPath = join(tempRoot, "verdaccio.yaml");
  const containerName = `letta-update-smoke-${Date.now()}`;

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_prefix: npmPrefix,
    npm_config_cache: npmCache,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_PREFIX: npmPrefix,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
  };

  writePermissiveVerdaccioConfig(verdaccioConfigPath);

  try {
    await runCommand("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-p",
      `${REGISTRY_PORT}:4873`,
      "-v",
      `${verdaccioConfigPath}:/verdaccio/conf/config.yaml:ro`,
      VERDACCIO_IMAGE,
    ]);

    await waitForVerdaccio();

    await prepareWorkspace(baseEnv, workspaceDir);
    await authenticateToRegistry(baseEnv);

    const oldTarball = await buildAndPackVersion(
      workspaceDir,
      OLD_VERSION,
      baseEnv,
    );
    const newTarball = await buildAndPackVersion(
      workspaceDir,
      NEW_VERSION,
      baseEnv,
    );

    await publishTarball(oldTarball, baseEnv);

    await runCommand(
      "npm",
      [
        "install",
        "-g",
        `${PACKAGE_NAME}@${OLD_VERSION}`,
        "--registry",
        REGISTRY_URL,
      ],
      { env: baseEnv, timeoutMs: 180000 },
    );

    await publishTarball(newTarball, baseEnv);

    const globalBinDir = await getGlobalBinDir(baseEnv);

    const testEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      PATH: `${globalBinDir}:${process.env.PATH ?? ""}`,
      LETTA_CODE_AGENT_ROLE: "subagent",
      LETTA_UPDATE_PACKAGE_NAME: PACKAGE_NAME,
      LETTA_UPDATE_REGISTRY_BASE_URL: REGISTRY_URL,
      LETTA_UPDATE_INSTALL_REGISTRY_URL: REGISTRY_URL,
    };

    const resolved = await runCommand("bash", ["-lc", "command -v letta"], {
      env: testEnv,
    });

    if (!resolved.stdout.trim().startsWith(globalBinDir)) {
      throw new Error(
        `Expected letta binary in ${globalBinDir}, got ${resolved.stdout.trim()}`,
      );
    }

    if (mode === "manual") {
      await runManualUpdateFlow(testEnv);
      console.log("OK: manual update-chain smoke passed");
    } else {
      await runStartupUpdateFlow(testEnv);
      console.log("OK: startup update-chain smoke passed");
    }
  } finally {
    await runCommand("docker", ["stop", containerName], {
      expectExit: undefined,
    }).catch(() => {});

    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.stack : error));
  process.exit(1);
});
