import { afterEach, describe, expect, test } from "bun:test";
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
import {
  formatModsList,
  listMods,
  runModsSubcommand,
} from "@/cli/subcommands/mods";

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

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("mods subcommand", () => {
  test("lists harness loose mods without an agent section", () => {
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

  test("lists agent loose mods before harness loose mods", () => {
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

  test("uses runtime loose mod discovery rules", () => {
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

  test("lists installed packages separately from harness loose mods", () => {
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
      expect(consoleCapture.errors).toEqual([]);
    } finally {
      consoleCapture.restore();
    }
  });

  test("rejects unknown actions", async () => {
    const consoleCapture = captureConsole();
    try {
      const exitCode = await runModsSubcommand(["install"]);

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "Unknown mods action: install",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Usage:");
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
