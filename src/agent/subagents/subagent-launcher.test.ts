import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { resolveSubagentLauncher } from "@/agent/subagents/subagent-launcher";

const MISSING_SCRIPT =
  "C:\\Users\\example\\AppData\\Local\\fnm_multishells\\session\\node_modules\\@letta-ai\\letta-code\\letta.js";

describe("resolveSubagentLauncher with a missing inherited entrypoint", () => {
  test("falls back to letta on PATH for a missing bundled js on win32", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", MISSING_SCRIPT],
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      fileExists: () => false,
      platform: "win32",
    });

    expect(launcher).toEqual({
      command: "letta",
      args: ["-p", "prompt"],
    });
  });

  test("falls back to letta on PATH for a missing bundled js elsewhere", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", "/usr/local/lib/letta.js"],
      execPath: "/usr/local/bin/node",
      fileExists: () => false,
      platform: "linux",
    });

    expect(launcher).toEqual({
      command: "letta",
      args: ["-p", "prompt"],
    });
  });

  test("falls back to letta on PATH for a missing dev entrypoint", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["bun", "/tmp/custom-runner.ts"],
      execPath: "/opt/homebrew/bin/bun",
      fileExists: () => false,
      platform: "darwin",
    });

    expect(launcher).toEqual({
      command: "letta",
      args: ["-p", "prompt"],
    });
  });

  test("keeps the inherited path when the entrypoint still exists", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", MISSING_SCRIPT],
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      fileExists: () => true,
      platform: "win32",
    });

    expect(launcher).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [MISSING_SCRIPT, "-p", "prompt"],
    });
  });

  test("prefers LETTA_CODE_BIN over the PATH fallback", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {
        LETTA_CODE_BIN: "custom-node",
      } as NodeJS.ProcessEnv,
      argv: ["node", MISSING_SCRIPT],
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      fileExists: () => false,
      platform: "win32",
    });

    expect(launcher).toEqual({
      command: "custom-node",
      args: ["-p", "prompt"],
    });
  });

  test("existence-checks the resolved absolute path, not the raw argv entry", () => {
    const cwd = path.join(path.sep, "opt", "letta-code");
    const seen: string[] = [];

    resolveSubagentLauncher(["-p", "prompt"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", "letta.js"],
      fileExists: (filePath) => {
        seen.push(filePath);
        return true;
      },
      platform: "linux",
    });

    expect(seen).toEqual([path.resolve(cwd, "letta.js")]);
    expect(seen[0]).not.toBe("letta.js");
  });

  test("stays on the PATH fallback when argv carries no script", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", ""],
      execPath: "/usr/local/bin/node",
      fileExists: () => false,
      platform: "linux",
    });

    expect(launcher).toEqual({
      command: "letta",
      args: ["-p", "prompt"],
    });
  });
});