import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type WrapSubagentLauncherInput,
  wrapSubagentLauncher,
} from "@/agent/subagents/sandbox";
import { getLocalBackendCrossAgentTreeRoot } from "@/backend/local/paths";
import {
  canonicalizeRoot,
  getDefaultAgentsTreeRoot,
  getLettaHomeRoot,
} from "@/permissions/sandbox-policy";
import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  isShellSandboxEnabled,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import { SANDBOX_EXEC_PATH } from "@/sandbox/seatbelt";

const SEATBELT: SandboxAvailability = {
  backend: "seatbelt",
  reason: "test",
};

const LAUNCHER = {
  command: "bun",
  args: ["run", "src/index.ts", "--headless"],
};

test("sandboxed shell scratch files are writable while workspace writes stay denied", () => {
  const availability = detectSandboxBackend();
  if (!availability.backend) return;
  const workspace = mkdtempSync(join(tmpdir(), "memory-sandbox-test-"));
  try {
    const result = wrapSubagentLauncher({
      ...baseInput(),
      availability,
      launcher: {
        command: process.execPath,
        args: [
          "-e",
          `const fs = require('node:fs');
           const path = require('node:path');
           const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'letta-background-'));
           try {
             fs.writeFileSync(path.join(scratch, 'output.log'), 'shell output');
             let denied = false;
             try { fs.writeFileSync(${JSON.stringify(join(workspace, "forbidden"))}, 'no'); }
             catch (error) { if (['EPERM', 'EACCES', 'EROFS'].includes(error.code)) denied = true; else throw error; }
             if (!denied) throw new Error('Workspace write was allowed');
           } finally { fs.rmSync(scratch, { recursive: true }); }`,
        ],
      },
    });
    if (!result) throw new Error("Expected sandbox launcher");
    expect(() =>
      execFileSync(result.command, result.args, {
        env: { ...process.env, ...result.sandboxEnv },
        cwd: workspace,
        stdio: "pipe",
      }),
    ).not.toThrow();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a Linux memory child's Bash output redirects from a read-only external scratch", () => {
  const availability = detectSandboxBackend();
  if (availability.backend !== "bwrap") return;

  const workspace = mkdtempSync(join(tmpdir(), "memory-scratch-test-"));
  const fixtureRoot = join(
    getDefaultAgentsTreeRoot(),
    `scratch-test-${crypto.randomUUID()}`,
  );
  const ownMemory = join(fixtureRoot, "parent", "memory");
  const otherMemory = join(fixtureRoot, "other");
  const externalScratch = join(workspace, "scratch");
  const transcript = join(workspace, "transcript.txt");
  mkdirSync(ownMemory, { recursive: true });
  mkdirSync(otherMemory, { recursive: true });
  mkdirSync(externalScratch);
  writeFileSync(transcript, "synthetic transcript");

  let redirectedScratch: string | undefined;
  try {
    const result = wrapSubagentLauncher({
      ...baseInput(),
      availability,
      memoryRoots: [ownMemory],
      inheritedPrimaryRoot: ownMemory,
      env: { ...process.env, LETTA_SCRATCHPAD: externalScratch },
      launcher: {
        command: process.execPath,
        args: [
          "-e",
          `const fs = require('node:fs');
           try {
             const { createBackgroundOutputFile } = await import(${JSON.stringify(join(import.meta.dir, "../../tools/impl/process_manager.ts"))});
             createBackgroundOutputFile('bash_1');
           } catch (error) {
             console.error(error.code);
             process.exit(2);
           }
           if (fs.readFileSync(${JSON.stringify(transcript)}, 'utf8') !== 'synthetic transcript') throw new Error('Transcript unreadable');
           fs.writeFileSync(${JSON.stringify(join(ownMemory, "memory.md"))}, 'memory');
           for (const denied of [${JSON.stringify(join(workspace, "forbidden"))}, ${JSON.stringify(join(otherMemory, "forbidden"))}]) {
             try { fs.writeFileSync(denied, 'no'); throw new Error('Sandbox allowed forbidden write'); }
             catch (error) { if (!['EPERM', 'EACCES', 'EROFS', 'ENOENT'].includes(error.code)) throw error; }
           }`,
        ],
      },
    });
    if (!result) throw new Error("Expected sandbox launcher");
    redirectedScratch = result.sandboxEnv.LETTA_SCRATCHPAD;

    const inherited = spawnSync(result.command, result.args, {
      env: {
        ...process.env,
        ...result.sandboxEnv,
        LETTA_SCRATCHPAD: externalScratch,
      },
      cwd: workspace,
      encoding: "utf8",
    });
    expect(inherited.status).toBe(2);
    expect(inherited.stderr).toContain("EROFS");

    const corrected = spawnSync(result.command, result.args, {
      env: {
        ...process.env,
        LETTA_SCRATCHPAD: externalScratch,
        ...result.sandboxEnv,
      },
      cwd: workspace,
      encoding: "utf8",
    });
    expect(corrected.status).toBe(0);
    expect(existsSync(join(redirectedScratch as string, "bash_1.log"))).toBe(
      true,
    );
    expect(existsSync(join(ownMemory, "memory.md"))).toBe(true);
    expect(existsSync(join(workspace, "forbidden"))).toBe(false);
    expect(existsSync(join(otherMemory, "forbidden"))).toBe(false);
  } finally {
    if (redirectedScratch)
      rmSync(redirectedScratch, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

function baseInput(): WrapSubagentLauncherInput {
  return {
    launcher: LAUNCHER,
    launchProfile: "memory-subagent",
    backendMode: "api",
    memoryRoots: ["/home/u/.letta/agents/parent/memory"],
    inheritedPrimaryRoot: "/home/u/.letta/agents/parent/memory",
    env: { LETTA_FS_SANDBOX: "1" } as NodeJS.ProcessEnv,
    availability: SEATBELT,
  };
}

function defineValues(args: string[], prefix: string): string[] {
  return args
    .filter((a) => a.startsWith(prefix))
    .map((a) => a.slice(prefix.length));
}

test("isFsSandboxEnabled is on by default and only an explicit off-switch disables it", () => {
  // Default on (unset / empty).
  expect(isFsSandboxEnabled({})).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "" })).toBe(true);
  // Explicit on values still on.
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "1" })).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "true" })).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "TRUE" })).toBe(true);
  // Only the off-switch turns it off.
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "0" })).toBe(false);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "false" })).toBe(false);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "FALSE" })).toBe(false);
});

test("isShellSandboxEnabled is off by default and only an explicit on-switch enables it", () => {
  // Default off (unset / empty): only memory subagents are sandboxed.
  expect(isShellSandboxEnabled({})).toBe(false);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "" })).toBe(false);
  // Explicit off values stay off.
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "0" })).toBe(false);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "false" })).toBe(false);
  // Only the on-switch turns it on.
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "1" })).toBe(true);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "true" })).toBe(true);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "TRUE" })).toBe(true);
});

test("wraps an API subagent with the memory-subagent profile under the backend", () => {
  const result = wrapSubagentLauncher(baseInput());
  expect(result).not.toBeNull();
  expect(result?.command).toBe(SANDBOX_EXEC_PATH);
  // Original launcher survives intact after the -- separator.
  const sep = result?.args.indexOf("--") ?? -1;
  expect(sep).toBeGreaterThan(0);
  expect(result?.args.slice(sep + 1)).toEqual([
    "bun",
    "run",
    "src/index.ts",
    "--headless",
  ]);
  expect(result?.sandboxEnv[SANDBOX_ENV_VAR]).toBe("seatbelt");
  expect(result?.backend).toBe("seatbelt");
  expect(defineValues(result?.args ?? [], "-DDENIED_")).toEqual([
    `0=${getDefaultAgentsTreeRoot()}`,
    `1=${canonicalizeRoot(getLocalBackendCrossAgentTreeRoot())}`,
  ]);
});

test.each([
  join(tmpdir(), "parent-scratch"),
  join(getDefaultAgentsTreeRoot(), "other", "scratch"),
  "relative/parent-scratch",
  join(getDefaultAgentsTreeRoot(), "missing-scratch-root", "memory", "scratch"),
])(
  "redirects a memory subagent's unwritable scratchpad without expanding its sandbox: %s",
  (configuredScratchpad) => {
    const result = wrapSubagentLauncher({
      ...baseInput(),
      env: {
        LETTA_FS_SANDBOX: "1",
        LETTA_SCRATCHPAD: configuredScratchpad,
      },
    });
    const scratchpad = result?.sandboxEnv.LETTA_SCRATCHPAD;
    try {
      expect(scratchpad).toStartWith(join(getLettaHomeRoot(), "tmp"));
      expect(scratchpad).not.toBe(configuredScratchpad);
      expect(existsSync(scratchpad as string)).toBe(true);
      expect(result?.args.join(" ")).not.toContain(configuredScratchpad);
    } finally {
      if (scratchpad) rmSync(scratchpad, { recursive: true, force: true });
    }
  },
);

test("preserves an explicitly configured scratchpad already writable by the sandbox", () => {
  const configuredScratchpad = join(getLettaHomeRoot(), "tmp", "allowed");
  const result = wrapSubagentLauncher({
    ...baseInput(),
    env: { LETTA_FS_SANDBOX: "1", LETTA_SCRATCHPAD: configuredScratchpad },
  });
  expect(result?.sandboxEnv.LETTA_SCRATCHPAD).toBeUndefined();
});

test("redirects scratch under a memory root whose bwrap bind does not exist", () => {
  const missingMemory = join(
    getDefaultAgentsTreeRoot(),
    "not-created",
    "memory",
  );
  const result = wrapSubagentLauncher({
    ...baseInput(),
    availability: { backend: "bwrap", bwrapPath: "bwrap", reason: "test" },
    memoryRoots: [missingMemory],
    inheritedPrimaryRoot: missingMemory,
    env: {
      LETTA_FS_SANDBOX: "1",
      LETTA_SCRATCHPAD: join(missingMemory, "scratch"),
    },
  });
  const scratchpad = result?.sandboxEnv.LETTA_SCRATCHPAD;
  try {
    expect(scratchpad).toStartWith(join(getLettaHomeRoot(), "tmp"));
  } finally {
    if (scratchpad) rmSync(scratchpad, { recursive: true, force: true });
  }
});

test("returns null when the flag is off", () => {
  expect(
    wrapSubagentLauncher({ ...baseInput(), env: { LETTA_FS_SANDBOX: "0" } }),
  ).toBeNull();
});

test("returns null for non-memory-subagent launch profiles", () => {
  expect(
    wrapSubagentLauncher({ ...baseInput(), launchProfile: "default" }),
  ).toBeNull();
  expect(
    wrapSubagentLauncher({ ...baseInput(), launchProfile: undefined }),
  ).toBeNull();
});

test("wraps a LOCAL subagent with the memory-subagent profile (deny-list against the memfs tree)", () => {
  const storageDir = "/home/u/.letta/lc-local-backend";
  const memoryRoot = `${storageDir}/memfs/parent/memory`;
  const result = wrapSubagentLauncher({
    ...baseInput(),
    backendMode: "local",
    memoryRoots: [memoryRoot],
    inheritedPrimaryRoot: memoryRoot,
    localBackendStorageDir: storageDir,
  });
  // Local is no longer skipped: the child is confined under the backend, with
  // its policy keyed to the memfs tree (asserted in sandbox-policy.test.ts).
  expect(result).not.toBeNull();
  expect(result?.command).toBe(SANDBOX_EXEC_PATH);
  expect(result?.sandboxEnv[SANDBOX_ENV_VAR]).toBe("seatbelt");
  expect(defineValues(result?.args ?? [], "-DDENIED_")).toEqual([
    `0=${getDefaultAgentsTreeRoot()}`,
    `1=${canonicalizeRoot(getLocalBackendCrossAgentTreeRoot(storageDir))}`,
  ]);
});

test("returns null when no sandbox backend is available", () => {
  expect(
    wrapSubagentLauncher({
      ...baseInput(),
      availability: { backend: null, reason: "none" },
    }),
  ).toBeNull();
});

test("returns null when there are no memory roots to scope to", () => {
  expect(
    wrapSubagentLauncher({
      ...baseInput(),
      memoryRoots: [],
      inheritedPrimaryRoot: null,
    }),
  ).toBeNull();
});

test("memoryScope confines a reflection subagent to an exact worktree plus git metadata", () => {
  const result = wrapSubagentLauncher({
    ...baseInput(),
    memoryScope: {
      primaryRoot: "/home/u/.letta/agents/parent/memory-worktrees/reflection-1",
      writableRoots: [
        "/home/u/.letta/agents/parent/memory-worktrees/reflection-1",
        "/home/u/.letta/agents/parent/memory/.git",
      ],
      readonlyRoots: ["/home/u/.letta/agents/parent"],
    },
  });

  expect(result).not.toBeNull();
  expect(defineValues(result?.args ?? [], "-DWRITABLE_")).toEqual([
    `0=${canonicalizeRoot("/home/u/.letta/agents/parent/memory-worktrees/reflection-1")}`,
    `1=${canonicalizeRoot("/home/u/.letta/agents/parent/memory/.git")}`,
  ]);
  expect(
    defineValues(result?.args ?? [], "-DREADONLY_").map((value) =>
      value.replace(/^\d+=/, ""),
    ),
  ).toContain(canonicalizeRoot("/home/u/.letta/agents/parent"));
});
