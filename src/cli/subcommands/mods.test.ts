import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  formatModsList,
  listMods,
  runModsSubcommand,
} from "@/cli/subcommands/mods";
import { __testOverrideNpmManagedModPackageInstaller } from "@/mods/package-installer";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-mods-list-"));
  tempRoots.push(dir);
  return dir;
}

function captureConsole(): {
  errors: string[];
  logs: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };
  return {
    errors,
    logs,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function createChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function writeManagedPackage(params: {
  capabilities?: string[];
  enabled?: boolean;
  entries?: string[];
  modsRoot: string;
  root?: string;
  source?: string;
  version?: string;
}): string {
  const source = params.source ?? "npm:@caren/my-mod";
  const version = params.version ?? "0.1.0";
  const packageRootRelative = params.root ?? "packages/npm/@caren/my-mod";
  const entries = params.entries ?? ["mods/index.ts"];
  const packageRoot = join(params.modsRoot, ...packageRootRelative.split("/"));
  mkdirSync(join(packageRoot, "mods"), { recursive: true });
  writeFileSync(join(packageRoot, "mods", "index.ts"), "export {};\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        letta: {
          manifestVersion: 1,
          mods: entries,
          ...(params.capabilities ? { capabilities: params.capabilities } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(params.modsRoot, "packages.json"),
    `${JSON.stringify(
      {
        packages: [
          {
            source,
            version,
            enabled: params.enabled ?? true,
            root: packageRootRelative,
            entries,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return packageRoot;
}

function writeInstalledNpmPackage(params: {
  cwd: string;
  version?: string;
}): void {
  const packageRoot = join(params.cwd, "node_modules", "@caren", "my-mod");
  mkdirSync(join(packageRoot, "mods"), { recursive: true });
  writeFileSync(join(packageRoot, "mods", "index.ts"), "export {};\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@caren/my-mod",
        version: params.version ?? "0.2.0",
        letta: {
          manifestVersion: 1,
          mods: ["mods/index.ts"],
        },
      },
      null,
      2,
    )}\n`,
  );
}

afterEach(() => {
  __testOverrideNpmManagedModPackageInstaller({});
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("mods subcommand", () => {
  test("lists harness mods without an agent section", () => {
    const root = createTempDir();
    const harnessMods = join(root, "mods");
    mkdirSync(harnessMods, { recursive: true });
    writeFileSync(join(harnessMods, "statusline.ts"), "export {};\n");
    writeFileSync(join(harnessMods, "provider.mjs"), "export {};\n");

    const result = listMods({ globalModsDirectory: harnessMods });

    expect(result.agent).toBeUndefined();
    expect(result.harness.files).toEqual([
      join(harnessMods, "provider.mjs"),
      join(harnessMods, "statusline.ts"),
    ]);
    expect(formatModsList(result)).toBe(
      [
        "Harness mods",
        `  enabled  ${join(harnessMods, "provider.mjs")}`,
        `  enabled  ${join(harnessMods, "statusline.ts")}`,
        "",
        "Installed packages",
        "  (none)",
      ].join("\n"),
    );
  });

  test("lists legacy extensions alongside harness mods", () => {
    const root = createTempDir();
    const harnessMods = join(root, "mods");
    const legacyExtensions = join(root, "extensions");
    mkdirSync(harnessMods, { recursive: true });
    mkdirSync(legacyExtensions, { recursive: true });
    writeFileSync(join(harnessMods, "web-search.ts"), "export {};\n");
    writeFileSync(join(legacyExtensions, "review.ts"), "export {};\n");

    const result = listMods({
      globalModsDirectory: harnessMods,
      legacyGlobalExtensionsDirectory: legacyExtensions,
    });

    expect(result.legacyHarness?.files).toEqual([
      join(legacyExtensions, "review.ts"),
    ]);
    expect(result.harness.files).toEqual([join(harnessMods, "web-search.ts")]);
    expect(formatModsList(result)).toBe(
      [
        "Legacy extensions",
        `  enabled  ${join(legacyExtensions, "review.ts")}`,
        "",
        "Harness mods",
        `  enabled  ${join(harnessMods, "web-search.ts")}`,
        "",
        "Installed packages",
        "  (none)",
      ].join("\n"),
    );
  });

  test("lists agent mods before harness mods", () => {
    const root = createTempDir();
    const harnessMods = join(root, "mods");
    const agentMods = join(root, "memory", "mods");
    mkdirSync(harnessMods, { recursive: true });
    mkdirSync(agentMods, { recursive: true });
    writeFileSync(join(harnessMods, "global.ts"), "export {};\n");
    writeFileSync(join(agentMods, "agent.ts"), "export {};\n");

    const result = listMods({
      agentModsDirectory: agentMods,
      globalModsDirectory: harnessMods,
    });

    expect(result.agent?.files).toEqual([join(agentMods, "agent.ts")]);
    expect(result.harness.files).toEqual([join(harnessMods, "global.ts")]);
    expect(formatModsList(result)).toBe(
      [
        "Agent mods",
        `  enabled  ${join(agentMods, "agent.ts")}`,
        "",
        "Harness mods",
        `  enabled  ${join(harnessMods, "global.ts")}`,
        "",
        "Installed packages",
        "  (none)",
      ].join("\n"),
    );
  });

  test("formats empty sections", () => {
    const root = createTempDir();
    const result = listMods({
      agentModsDirectory: join(root, "memory", "mods"),
      globalModsDirectory: join(root, "mods"),
    });

    expect(formatModsList(result)).toBe(
      [
        "Agent mods",
        "  (none)",
        "",
        "Harness mods",
        "  (none)",
        "",
        "Installed packages",
        "  (none)",
      ].join("\n"),
    );
  });

  test("uses runtime mod file discovery rules", () => {
    const root = createTempDir();
    const harnessMods = join(root, "mods");
    mkdirSync(join(harnessMods, "nested"), { recursive: true });
    writeFileSync(join(harnessMods, "visible.tsx"), "export {};\n");
    writeFileSync(join(harnessMods, ".hidden.ts"), "export {};\n");
    writeFileSync(join(harnessMods, "notes.md"), "# not a mod\n");
    writeFileSync(join(harnessMods, "nested", "nested.ts"), "export {};\n");

    const result = listMods({ globalModsDirectory: harnessMods });

    expect(result.harness.files).toEqual([join(harnessMods, "visible.tsx")]);
  });

  test("lists installed packages separately from harness mods", () => {
    const root = createTempDir();
    const harnessMods = join(root, "mods");
    mkdirSync(harnessMods, { recursive: true });
    writeFileSync(join(harnessMods, "global.ts"), "export {};\n");
    writeManagedPackage({
      capabilities: ["commands"],
      modsRoot: harnessMods,
    });

    const result = listMods({ globalModsDirectory: harnessMods });

    expect(result.harness.files).toEqual([join(harnessMods, "global.ts")]);
    expect(result.packages).toMatchObject([
      {
        capabilities: ["commands"],
        enabled: true,
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);
    expect(formatModsList(result)).toContain(
      "  enabled  npm:@caren/my-mod@0.1.0    commands",
    );
  });

  test("lists installed packages from LETTA_MODS_DIR env var directory", () => {
    const root = createTempDir();
    const envMods = join(root, "env-mods");
    mkdirSync(envMods, { recursive: true });
    writeFileSync(join(envMods, "global.ts"), "export {};\n");
    writeManagedPackage({
      capabilities: ["commands"],
      modsRoot: envMods,
    });

    process.env.LETTA_MODS_DIR = envMods;
    // Override LETTA_EXTENSIONS_DIR to a temp path so the test never
    // touches ~/.letta/extensions/ on the developer's machine.
    process.env.LETTA_EXTENSIONS_DIR = join(root, "no-such-extensions");
    try {
      // No explicit globalModsDirectory — should fall back to env var
      const result = listMods();

      expect(result.harness.files).toEqual([join(envMods, "global.ts")]);
      expect(result.packages).toMatchObject([
        {
          capabilities: ["commands"],
          enabled: true,
          source: "npm:@caren/my-mod",
          version: "0.1.0",
        },
      ]);
    } finally {
      delete process.env.LETTA_MODS_DIR;
      delete process.env.LETTA_EXTENSIONS_DIR;
    }
  });

  test("lists package registry diagnostics", () => {
    const root = createTempDir();
    const harnessMods = join(root, "mods");
    mkdirSync(harnessMods, { recursive: true });
    writeFileSync(join(harnessMods, "packages.json"), "{\n");

    expect(
      formatModsList(listMods({ globalModsDirectory: harnessMods })),
    ).toContain("  error");
  });

  test("prints usage for help", async () => {
    const consoleCapture = captureConsole();
    try {
      const exitCode = await runModsSubcommand(["help"]);

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain("Usage:");
      expect(consoleCapture.logs.join("\n")).toContain("letta mods list");
      expect(consoleCapture.logs.join("\n")).toContain("letta mods package");
      expect(consoleCapture.logs.join("\n")).toContain("letta mods update");
      expect(consoleCapture.errors).toEqual([]);
    } finally {
      consoleCapture.restore();
    }
  });

  test("rejects unknown actions", async () => {
    const consoleCapture = captureConsole();
    try {
      const exitCode = await runModsSubcommand(["publish"]);

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "Unknown mods action: publish",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Usage:");
    } finally {
      consoleCapture.restore();
    }
  });

  test("package command creates a local package scaffold", async () => {
    const root = createTempDir();
    const sourceFile = join(root, "hello.ts");
    const outputDirectory = join(root, "hello-package");
    writeFileSync(sourceFile, "export default () => {};\n");
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand([
        "package",
        sourceFile,
        "--name",
        "@caren/hello-mod",
        "--out",
        outputDirectory,
      ]);

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        `Created mod package ${outputDirectory}`,
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Install with: letta install",
      );
      expect(
        JSON.parse(readFileSync(join(outputDirectory, "package.json"), "utf8")),
      ).toMatchObject({
        name: "@caren/hello-mod",
        letta: { manifestVersion: 1, mods: ["mods/hello.ts"] },
      });
      expect(existsSync(join(outputDirectory, "mods", "hello.ts"))).toBe(true);
    } finally {
      consoleCapture.restore();
    }
  });

  test("package command requires a package name", async () => {
    const root = createTempDir();
    const sourceFile = join(root, "hello.ts");
    writeFileSync(sourceFile, "export default () => {};\n");
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand(["package", sourceFile]);

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "Missing required --name",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Usage:");
    } finally {
      consoleCapture.restore();
    }
  });

  test("package command rejects agent option", async () => {
    const root = createTempDir();
    const sourceFile = join(root, "hello.ts");
    writeFileSync(sourceFile, "export default () => {};\n");
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand([
        "package",
        sourceFile,
        "--name",
        "hello-mod",
        "--agent",
        "agent-123",
      ]);

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "--agent is not supported for 'letta mods package'",
      );
    } finally {
      consoleCapture.restore();
    }
  });

  test("update command installs latest npm package and prints old to new version", async () => {
    const root = createTempDir();
    const modsRoot = join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeManagedPackage({ modsRoot });
    __testOverrideNpmManagedModPackageInstaller({
      spawnImpl: (_cmd, _args, options) => {
        if (!options.cwd) throw new Error("expected cwd");
        writeInstalledNpmPackage({ cwd: options.cwd.toString() });
        const child = createChildProcess();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand(
        ["update", "npm:@caren/my-mod"],
        { globalModsDirectory: modsRoot },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Updated npm:@caren/my-mod 0.1.0 -> 0.2.0",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Run /reload");
      expect(
        JSON.parse(readFileSync(join(modsRoot, "packages.json"), "utf8"))
          .packages[0].version,
      ).toBe("0.2.0");
    } finally {
      consoleCapture.restore();
    }
  });

  test("update command updates git package and prints old to new version", async () => {
    const root = createTempDir();
    const modsRoot = join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeManagedPackage({
      modsRoot,
      root: "packages/git/github.com/caren/git-mod",
      source: "git:https://github.com/caren/git-mod",
      version: "0.1.0",
    });
    __testOverrideNpmManagedModPackageInstaller({
      gitSpawnImpl: (_cmd, args) => {
        if (args[0] === "clone") {
          const packageRoot = String(args.at(-1));
          mkdirSync(join(packageRoot, "mods"), { recursive: true });
          writeFileSync(join(packageRoot, "mods", "index.ts"), "export {};\n");
          writeFileSync(
            join(packageRoot, "package.json"),
            `${JSON.stringify({
              name: "git-mod",
              version: "0.2.0",
              letta: {
                manifestVersion: 1,
                mods: ["mods/index.ts"],
              },
            })}\n`,
          );
        }
        const child = createChildProcess();
        queueMicrotask(() => {
          if (args[0] === "rev-parse") child.stdout?.emit("data", "def456\n");
          child.emit("exit", 0);
        });
        return child;
      },
    });
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand(
        ["update", "https://github.com/caren/git-mod"],
        { globalModsDirectory: modsRoot },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Updated git:https://github.com/caren/git-mod 0.1.0 -> 0.2.0",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Run /reload");
      expect(
        JSON.parse(readFileSync(join(modsRoot, "packages.json"), "utf8"))
          .packages[0].version,
      ).toBe("0.2.0");
    } finally {
      consoleCapture.restore();
    }
  });

  test("update command rejects agent option", async () => {
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand([
        "update",
        "npm:@caren/my-mod",
        "--agent",
        "agent-123",
      ]);

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "--agent is not supported for 'letta mods update'",
      );
    } finally {
      consoleCapture.restore();
    }
  });

  test("disable command updates the global package registry and prints reload hint", async () => {
    const root = createTempDir();
    const home = join(root, "home");
    const modsRoot = join(home, ".letta", "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeManagedPackage({ modsRoot });
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand(
        ["disable", "npm:@caren/my-mod"],
        { globalModsDirectory: modsRoot },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "disabled npm:@caren/my-mod@0.1.0",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Run /reload");
      const registry = JSON.parse(
        readFileSync(join(modsRoot, "packages.json"), "utf8"),
      );
      expect(registry.packages[0].enabled).toBe(false);
    } finally {
      consoleCapture.restore();
    }
  });

  test("enable command updates the global package registry", async () => {
    const root = createTempDir();
    const modsRoot = join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeManagedPackage({ enabled: false, modsRoot });
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand(
        ["enable", "npm:@caren/my-mod"],
        { globalModsDirectory: modsRoot },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "enabled npm:@caren/my-mod@0.1.0",
      );
      const registry = JSON.parse(
        readFileSync(join(modsRoot, "packages.json"), "utf8"),
      );
      expect(registry.packages[0].enabled).toBe(true);
    } finally {
      consoleCapture.restore();
    }
  });

  test("unknown package exits nonzero", async () => {
    const root = createTempDir();
    const modsRoot = join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeManagedPackage({ modsRoot });
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand(
        ["disable", "npm:@caren/missing-mod"],
        { globalModsDirectory: modsRoot },
      );

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "Managed mod package not found: npm:@caren/missing-mod",
      );
    } finally {
      consoleCapture.restore();
    }
  });

  test("remove command deletes package root", async () => {
    const root = createTempDir();
    const home = join(root, "home");
    const modsRoot = join(home, ".letta", "mods");
    mkdirSync(modsRoot, { recursive: true });
    const packageRoot = writeManagedPackage({ modsRoot });
    const consoleCapture = captureConsole();

    try {
      const exitCode = await runModsSubcommand(
        ["remove", "npm:@caren/my-mod@0.1.0"],
        { globalModsDirectory: modsRoot },
      );

      expect(exitCode).toBe(0);
      expect(existsSync(packageRoot)).toBe(false);
      const registry = JSON.parse(
        readFileSync(join(modsRoot, "packages.json"), "utf8"),
      );
      expect(registry.packages).toEqual([]);
    } finally {
      consoleCapture.restore();
    }
  });
});
