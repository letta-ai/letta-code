import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { getLocalBackendCrossAgentTreeRoot } from "@/backend/local/paths";
import { checkPermission } from "@/permissions/checker";
import {
  canonicalizeRoot,
  getDefaultAgentsTreeRoot,
} from "@/permissions/sandbox-policy";
import { runWithRuntimeContext } from "@/runtime-context";
import type { SandboxAvailability } from "@/sandbox/availability";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import { SANDBOX_EXEC_PATH } from "@/sandbox/seatbelt";
import { applyShellSandbox } from "@/tools/impl/shell-sandbox";

test.skipIf(process.platform !== "linux")(
  "Daytona root tool processes cannot mutate root memory; nested commits and trusted sync still work",
  () => {
    const base = mkdtempSync(join(tmpdir(), "readonly-memory-live-"));
    const memory = join(base, "memory");
    const remote = join(base, "remote.git");
    const upstream = join(base, "upstream");
    const previousFlag = process.env.LETTA_READONLY_ROOT_MEMORY_CONVERSATION;
    const previousRoot = process.env.MEMORY_DIR;
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      git("init", "--bare", remote);
      git("clone", remote, memory);
      mkdirSync(join(memory, "reference"));
      writeFileSync(join(memory, "MEMORY.md"), "original root");
      writeFileSync(join(memory, "reference", "MEMORY.md"), "reference index");
      git("-C", memory, "add", "MEMORY.md", "reference/MEMORY.md");
      git(
        "-C",
        memory,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial",
      );
      git("-C", memory, "push", "origin", "HEAD");
      git("clone", remote, upstream);
      process.env.LETTA_READONLY_ROOT_MEMORY_CONVERSATION = "conv-coordinator";
      process.env.MEMORY_DIR = memory;
      runWithRuntimeContext(
        { conversationId: "conv-coordinator", permissionMode: "unrestricted" },
        () => {
          expect(() =>
            applyShellSandbox(
              ["/bin/true"],
              memory,
              {},
              {
                backend: null,
                reason: "unavailable",
              },
            ),
          ).toThrow("requires Linux bubblewrap");
          for (const tool of ["Write", "Edit"]) {
            expect(
              checkPermission(
                tool,
                { file_path: join(memory, "MEMORY.md") },
                { allow: ["Write(**)", "Edit(**)"], deny: [], ask: [] },
                memory,
              ),
            ).toMatchObject({
              decision: "deny",
              matchedRule: "read-only root memory",
            });
          }
          expect(
            checkPermission(
              "ApplyPatch",
              {
                input: `*** Begin Patch\n*** Delete File: ${join(memory, "MEMORY.md")}\n*** End Patch`,
              },
              { allow: ["ApplyPatch"], deny: [], ask: [] },
              memory,
            ),
          ).toMatchObject({
            decision: "deny",
            matchedRule: "read-only root memory",
          });
        },
      );
      const run = (command: string) =>
        runWithRuntimeContext({ conversationId: "conv-coordinator" }, () => {
          const wrapped = applyShellSandbox(
            ["/bin/sh", "-c", command],
            memory,
            process.env,
          );
          const binary = wrapped.launcher[0];
          if (!binary) throw new Error("Missing sandbox launcher");
          return spawnSync(binary, wrapped.launcher.slice(1), {
            cwd: memory,
            env: wrapped.env,
            encoding: "utf8",
          });
        });
      for (const command of [
        "echo bad > MEMORY.md",
        "rm MEMORY.md",
        "mv MEMORY.md reference/moved.md",
        "echo bad > new.md",
        "chmod 777 MEMORY.md",
        "mkdir new-directory",
        "ln -s MEMORY.md alias.md",
        "mount -o remount,rw .",
        "unset LETTA_READONLY_ROOT_MEMORY_CONVERSATION; echo bad > MEMORY.md",
      ]) {
        const result = run(command);
        expect(result.status, command).not.toBe(0);
        expect(result.stderr).toMatch(
          /Read-only file system|Operation not permitted|permission denied/i,
        );
      }
      const nested = run(
        "echo allowed > reference/note.md && git add reference/note.md && git -c user.name=Test -c user.email=test@example.com commit -m nested",
      );
      expect(nested.status, nested.stderr).toBe(0);
      expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe(
        "original root",
      );
      // The trusted parent can pull a root edit without disabling protection in
      // any concurrently running tool namespace.
      writeFileSync(join(upstream, "MEMORY.md"), "updated by trusted sync");
      git("-C", upstream, "add", "MEMORY.md");
      git(
        "-C",
        upstream,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "root update",
      );
      git("-C", upstream, "push");
      git(
        "-C",
        memory,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "pull",
        "--rebase",
      );
      expect(run("cat MEMORY.md").stdout).toBe("updated by trusted sync");
      expect(run("echo bad > MEMORY.md").status).not.toBe(0);
      expect(
        runWithRuntimeContext({ conversationId: "conv-memory-worker" }, () =>
          applyShellSandbox(["/bin/true"], memory, {}),
        ).backend,
      ).toBeNull();
    } finally {
      if (previousFlag === undefined)
        delete process.env.LETTA_READONLY_ROOT_MEMORY_CONVERSATION;
      else process.env.LETTA_READONLY_ROOT_MEMORY_CONVERSATION = previousFlag;
      if (previousRoot === undefined) delete process.env.MEMORY_DIR;
      else process.env.MEMORY_DIR = previousRoot;
      rmSync(base, { recursive: true, force: true });
    }
  },
);

const SEATBELT: SandboxAvailability = { backend: "seatbelt", reason: "test" };
const NO_BACKEND: SandboxAvailability = { backend: null, reason: "test" };
const LAUNCHER = ["/bin/zsh", "-c", "echo hi"];
// The parent agent's cwd is the repo — outside ~/.letta/agents.
const REPO_CWD = process.cwd();

function defineValue(args: string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function defineValues(args: string[], prefix: string): string[] {
  return args
    .filter((a) => a.startsWith(prefix))
    .map((a) => a.slice(prefix.length));
}

test("no-op when the flag is off", () => {
  const result = applyShellSandbox(LAUNCHER, REPO_CWD, {}, SEATBELT);
  expect(result.backend).toBeNull();
  expect(result.launcher).toBe(LAUNCHER);
});

test("runtime workspace sandbox is fail-closed and does not need the global flag", () => {
  const base = mkdtempSync(join(tmpdir(), "shell-workspace-sandbox-"));
  const isolationRoot = join(base, "runs");
  const root = join(isolationRoot, "run-a");
  mkdirSync(root, { recursive: true });
  try {
    const result = runWithRuntimeContext(
      { workspaceSandbox: { root, isolationRoot } },
      () => applyShellSandbox(LAUNCHER, root, {}, SEATBELT),
    );
    expect(result.backend).toBe("seatbelt");
    expect(result.env[SANDBOX_ENV_VAR]).toBe("seatbelt");
    expect(defineValue(result.launcher, "-DDENIED_0=")).toBe(
      canonicalizeRoot(isolationRoot),
    );
    expect(defineValue(result.launcher, "-DWRITABLE_0=")).toBe(
      canonicalizeRoot(root),
    );
    expect(result.launcher[2]).toContain("(deny file-write*");

    expect(() =>
      runWithRuntimeContext({ workspaceSandbox: { root, isolationRoot } }, () =>
        applyShellSandbox(LAUNCHER, root, {}, NO_BACKEND),
      ),
    ).toThrow("requires a kernel sandbox backend");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("no-op when already inside a sandbox (no nested sandbox-exec)", () => {
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    {
      LETTA_FS_SANDBOX: "1",
      [SANDBOX_ENV_VAR]: "seatbelt",
      MEMORY_DIR: "/tmp/x/memory",
    },
    SEATBELT,
  );
  expect(result.backend).toBeNull();
  expect(result.launcher).toBe(LAUNCHER);
});

test("wraps unsandboxed subagent shell commands", () => {
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    {
      LETTA_FS_SANDBOX: "1",
      LETTA_CODE_AGENT_ROLE: "subagent",
      MEMORY_DIR: "/tmp/x/memory",
    },
    SEATBELT,
  );
  expect(result.backend).toBe("seatbelt");
  expect(result.env[SANDBOX_ENV_VAR]).toBe("seatbelt");
});

test("no-op for already sandboxed subagent processes", () => {
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    {
      LETTA_FS_SANDBOX: "1",
      LETTA_CODE_AGENT_ROLE: "subagent",
      [SANDBOX_ENV_VAR]: "bwrap",
      MEMORY_DIR: "/tmp/x/memory",
    },
    SEATBELT,
  );
  expect(result.backend).toBeNull();
});

test("no-op when no sandbox backend is available", () => {
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: "/tmp/x/memory" },
    NO_BACKEND,
  );
  expect(result.backend).toBeNull();
});

test("no-op when cwd is inside the agents tree (Seatbelt empty-env hazard)", () => {
  const cwdInTree = join(homedir(), ".letta", "agents", "self", "memory");
  const result = applyShellSandbox(
    LAUNCHER,
    cwdInTree,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: cwdInTree },
    SEATBELT,
  );
  expect(result.backend).toBeNull();
});

test("wraps an agent shell launcher: denies agents tree, carves self, sets sentinel", () => {
  const memDir = join(REPO_CWD, "nonexistent-mem", "memory");
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: memDir },
    SEATBELT,
  );

  expect(result.backend).toBe("seatbelt");
  expect(result.launcher[0]).toBe(SANDBOX_EXEC_PATH);
  // The inner launcher is preserved verbatim at the tail, after the `--`.
  expect(result.launcher).toContain("--");
  expect(result.launcher.slice(-3)).toEqual(LAUNCHER);
  expect(result.env[SANDBOX_ENV_VAR]).toBe("seatbelt");

  expect(defineValue(result.launcher, "-DDENIED_0=")).toBe(
    getDefaultAgentsTreeRoot(),
  );
  expect(defineValue(result.launcher, "-DWRITABLE_0=")).toBe(
    canonicalizeRoot(memDir),
  );
});

test("api backend: also walls off the local memfs tree", () => {
  const storageDir = join(REPO_CWD, "custom-local-backend");
  const memfsTree = getLocalBackendCrossAgentTreeRoot(storageDir);
  const apiMemDir = join(getDefaultAgentsTreeRoot(), "api-agent-xyz", "memory");
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    {
      LETTA_FS_SANDBOX: "1",
      LETTA_LOCAL_BACKEND_DIR: storageDir,
      MEMORY_DIR: apiMemDir,
    },
    SEATBELT,
  );

  expect(result.backend).toBe("seatbelt");
  expect(defineValues(result.launcher, "-DDENIED_")).toEqual([
    `0=${getDefaultAgentsTreeRoot()}`,
    `1=${canonicalizeRoot(memfsTree)}`,
  ]);
});

test("local backend: walls off both local memfs and ~/.letta/agents", () => {
  // A local-backend parent agent keeps its memory under lc-local-backend/memfs,
  // but it still must not read cloud/API memory projected under ~/.letta/agents.
  const storageDir = join(REPO_CWD, "custom-local-backend");
  const memfsTree = getLocalBackendCrossAgentTreeRoot(storageDir);
  const memDir = join(memfsTree, "local-agent-xyz", "memory");
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    {
      LETTA_FS_SANDBOX: "1",
      LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
      LETTA_LOCAL_BACKEND_DIR: storageDir,
      MEMORY_DIR: memDir,
    },
    SEATBELT,
  );

  expect(result.backend).toBe("seatbelt");
  expect(defineValues(result.launcher, "-DDENIED_")).toEqual([
    `0=${getDefaultAgentsTreeRoot()}`,
    `1=${canonicalizeRoot(memfsTree)}`,
  ]);
  // Self agent dir carved writable (both /memory and /memory-worktrees collapse
  // to the single agent dir).
  const writables = result.launcher.filter((a) => a.startsWith("-DWRITABLE_"));
  expect(writables).toEqual([
    `-DWRITABLE_0=${canonicalizeRoot(join(memfsTree, "local-agent-xyz"))}`,
  ]);
});

test("carves the whole self agent dir for an in-tree memory root", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "test-cross-agent-xyz");
  const memDir = join(
    homedir(),
    ".letta",
    "agents",
    "test-cross-agent-xyz",
    "memory",
  );
  const result = applyShellSandbox(
    LAUNCHER,
    REPO_CWD,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: memDir },
    SEATBELT,
  );

  expect(result.backend).toBe("seatbelt");
  // Both the /memory root and its /memory-worktrees sibling collapse to the
  // single agent directory — so there is exactly one writable carve-out.
  const writables = result.launcher.filter((a) => a.startsWith("-DWRITABLE_"));
  expect(writables).toEqual([`-DWRITABLE_0=${canonicalizeRoot(agentDir)}`]);
});
