import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLooseModsList,
  listLooseMods,
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

    const result = listLooseMods({ globalModsDirectory: harnessMods });

    expect(result.agent).toBeUndefined();
    expect(result.harness.files).toEqual([
      join(harnessMods, "provider.mjs"),
      join(harnessMods, "statusline.ts"),
    ]);
    expect(formatLooseModsList(result)).toBe(
      [
        "Harness mods",
        `  enabled  ${join(harnessMods, "provider.mjs")}`,
        `  enabled  ${join(harnessMods, "statusline.ts")}`,
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

    const result = listLooseMods({
      agentModsDirectory: agentMods,
      globalModsDirectory: harnessMods,
    });

    expect(result.agent?.files).toEqual([join(agentMods, "agent.ts")]);
    expect(result.harness.files).toEqual([join(harnessMods, "global.ts")]);
    expect(formatLooseModsList(result)).toBe(
      [
        "Agent mods",
        `  enabled  ${join(agentMods, "agent.ts")}`,
        "",
        "Harness mods",
        `  enabled  ${join(harnessMods, "global.ts")}`,
      ].join("\n"),
    );
  });

  test("formats empty sections", () => {
    const root = createTempDir();
    const result = listLooseMods({
      agentModsDirectory: join(root, "memory", "mods"),
      globalModsDirectory: join(root, "mods"),
    });

    expect(formatLooseModsList(result)).toBe(
      ["Agent mods", "  (none)", "", "Harness mods", "  (none)"].join("\n"),
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

    const result = listLooseMods({ globalModsDirectory: harnessMods });

    expect(result.harness.files).toEqual([join(harnessMods, "visible.tsx")]);
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
});
