import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUN_REEXEC_ENV,
  BUN_REEXEC_PRELUDE,
  NODE_LAUNCHER,
  normalizeLauncherContent,
  normalizeLauncherFile,
  SKIP_BUN_REEXEC_ENV,
} from "./launcher-shebang.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const tempDirs = [];
const unixTest = process.platform === "win32" ? test.skip : test;
let realNodePath;

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "letta-launcher-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function getRealNodePath() {
  if (realNodePath) return realNodePath;
  const result = spawnSync("node", ["-p", "process.execPath"], {
    encoding: "utf-8",
  });
  expect(result.status).toBe(0);
  realNodePath = result.stdout.trim();
  return realNodePath;
}

function linkNodeInto(binDir) {
  symlinkSync(getRealNodePath(), join(binDir, "node"));
}

function makeLauncherFixture(body) {
  const dir = makeTempDir();
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  linkNodeInto(binDir);

  const scriptPath = join(dir, "letta.js");
  writeExecutable(scriptPath, normalizeLauncherContent(body));

  return { binDir, scriptPath };
}

function minimalUnixPath(binDir) {
  return [binDir, "/bin", "/usr/bin"].join(":");
}

function firstLines(path, count) {
  return readFileSync(path, "utf-8").split("\n").slice(0, count);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("launcher shebang normalization", () => {
  test("keeps the published bin target on a Node shebang for Windows shims", () => {
    const body = "console.log('hello');\n";
    const normalized = normalizeLauncherContent(body);

    expect(normalized.split("\n")[0]).toBe(NODE_LAUNCHER);
    expect(normalized).toContain(BUN_REEXEC_PRELUDE);
  });

  test("repairs Node shebangs and stays idempotent", () => {
    const body = "console.log('hello');\n";
    const normalized = normalizeLauncherContent(`${NODE_LAUNCHER}\n${body}`);

    expect(normalized).toBe(`${NODE_LAUNCHER}\n${BUN_REEXEC_PRELUDE}\n${body}`);
    expect(normalizeLauncherContent(normalized)).toBe(normalized);
  });

  test("normalizes old shell launchers and writes launcher files idempotently", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "letta.js");
    const body = "console.log('hello');\n";
    const oldShellLauncher = [
      "#!/bin/sh",
      `":" //#; exec /usr/bin/env sh -c 'command -v bun >/dev/null && exec bun "$0" "$@" || exec node "$0" "$@"' "$0" "$@"`,
    ].join("\n");

    writeFileSync(filePath, `${oldShellLauncher}\n${body}`);

    expect(normalizeLauncherFile(filePath)).toEqual({
      changed: true,
      launcher: NODE_LAUNCHER,
    });
    expect(readFileSync(filePath, "utf-8")).toBe(
      `${NODE_LAUNCHER}\n${BUN_REEXEC_PRELUDE}\n${body}`,
    );
    expect(normalizeLauncherFile(filePath)).toEqual({
      changed: false,
      launcher: NODE_LAUNCHER,
    });
  });
});

describe("launcher runtime selection", () => {
  unixTest(
    "prefers Bun on direct executable invocation and propagates args plus exit status",
    () => {
      const { binDir, scriptPath } = makeLauncherFixture(
        "console.log('node body should not run');\nprocess.exit(99);\n",
      );
      writeExecutable(
        join(binDir, "bun"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "1.0.0\\n"
  exit 0
fi
printf "bun:%s:%s:%s:%s\\n" "$${BUN_REEXEC_ENV}" "$1" "$2" "$3"
exit 37
`,
      );

      const result = spawnSync(scriptPath, ["--probe", "value"], {
        encoding: "utf-8",
        env: { ...process.env, PATH: minimalUnixPath(binDir) },
      });

      expect(result.status).toBe(37);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`bun:1:${scriptPath}:--probe:value\n`);
    },
  );

  unixTest("falls back to Node when Bun is absent from PATH", () => {
    const { binDir, scriptPath } = makeLauncherFixture(
      "console.log(`node:${process.argv.slice(2).join(':')}`);\nprocess.exit(23);\n",
    );

    const result = spawnSync(scriptPath, ["--probe", "value"], {
      encoding: "utf-8",
      env: { ...process.env, PATH: minimalUnixPath(binDir) },
    });

    expect(result.status).toBe(23);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("node:--probe:value\n");
  });

  unixTest("falls back to Node when Bun fails its runtime probe", () => {
    const { binDir, scriptPath } = makeLauncherFixture(
      "console.log('node:invalid-bun');\n",
    );
    writeExecutable(join(binDir, "bun"), "not an executable format\n");

    const result = spawnSync(scriptPath, [], {
      encoding: "utf-8",
      env: { ...process.env, PATH: minimalUnixPath(binDir) },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("node:invalid-bun\n");
  });

  unixTest(
    "does not recurse when the artifact is already running under Bun",
    () => {
      const { binDir, scriptPath } = makeLauncherFixture(
        "console.log(`bun-body:${typeof Bun !== 'undefined'}:${process.env.LETTA_CODE_BUN_REEXECED ?? 'unset'}`);\n",
      );
      writeExecutable(
        join(binDir, "bun"),
        `#!/bin/sh
printf "recursive bun shim should not run\\n"
exit 64
`,
      );

      const result = spawnSync(process.execPath, [scriptPath, "--probe"], {
        encoding: "utf-8",
        env: { ...process.env, PATH: minimalUnixPath(binDir) },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("bun-body:true:unset\n");
    },
  );

  unixTest("honors the re-exec marker under Node", () => {
    const { binDir, scriptPath } = makeLauncherFixture(
      "console.log(`node-marker:${process.env.LETTA_CODE_BUN_REEXECED}`);\n",
    );
    writeExecutable(
      join(binDir, "bun"),
      `#!/bin/sh
printf "bun should not run\\n"
exit 64
`,
    );

    const result = spawnSync(scriptPath, [], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: minimalUnixPath(binDir),
        [BUN_REEXEC_ENV]: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("node-marker:1\n");
  });

  unixTest(
    "can be forced to stay on Node for explicit Node compatibility smoke",
    () => {
      const { binDir, scriptPath } = makeLauncherFixture(
        "console.log(`node-skip:${typeof Bun === 'undefined'}`);\n",
      );
      writeExecutable(
        join(binDir, "bun"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf "bun should not run\\n"
exit 64
`,
      );

      const result = spawnSync(scriptPath, [], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: minimalUnixPath(binDir),
          [SKIP_BUN_REEXEC_ENV]: "1",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("node-skip:true\n");
    },
  );
});

describe("build, package, and staging consumers", () => {
  unixTest(
    "writes a Windows-shim-safe Node shebang plus Bun bootstrap into the built artifact",
    () => {
      const result = spawnSync("bun", ["run", "build.js"], {
        cwd: projectRoot,
        encoding: "utf-8",
        env: { ...process.env, LETTA_CODE_TELEM: "0" },
        timeout: 120000,
      });

      if (result.status !== 0) {
        throw new Error(
          `build.js failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }

      expect(firstLines(join(projectRoot, "letta.js"), 2)).toEqual([
        NODE_LAUNCHER,
        BUN_REEXEC_PRELUDE.split("\n")[0],
      ]);
    },
    { timeout: 150000 },
  );

  test("keeps single-file package, release, updater, and Nix staging assumptions", () => {
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf-8"),
    );
    const flake = readFileSync(join(projectRoot, "flake.nix"), "utf-8");
    const releaseWorkflow = readFileSync(
      join(projectRoot, ".github", "workflows", "release.yml"),
      "utf-8",
    );
    const updateSmoke = readFileSync(
      join(projectRoot, "src", "test-utils", "update-chain-smoke.ts"),
      "utf-8",
    );
    const desktopUpdateTest = readFileSync(
      join(projectRoot, "src", "updater", "auto-update.test.ts"),
      "utf-8",
    );

    expect(packageJson.bin).toEqual({ letta: "letta.js" });
    expect(packageJson.files).toContain("letta.js");
    expect(packageJson.exports["."]).toBe("./letta.js");
    expect(flake).toContain('--add-flags "$out/lib/letta-code/letta.js"');
    expect(releaseWorkflow).toContain("files: letta.js");
    expect(updateSmoke).toContain('runCommand("letta", ["--version"]');
    expect(desktopUpdateTest).toContain(
      "app.asar.unpacked/node_modules/@letta-ai/letta-code/letta.js",
    );
  });
});
