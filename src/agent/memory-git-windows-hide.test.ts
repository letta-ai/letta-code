import { afterAll, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const originalExecFile = childProcess.execFile;
const originalSpawnSync = childProcess.spawnSync;
const originalExecFileSync = childProcess.execFileSync;

afterAll(() => mock.restore());

test("hides direct Git and validator launches for MemFS operations and the viewer", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { windowsHide?: boolean; cwd?: string };
  }> = [];
  const execFileMock = Object.assign(
    (
      command: string,
      args: string[],
      options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ command, args, options });
      return originalExecFile(command, args, options, callback);
    },
    {
      [promisify.custom]: async (
        command: string,
        args: string[],
        options: object,
      ) => {
        calls.push({ command, args, options });
        return promisify(originalExecFile)(command, args, options);
      },
    },
  );
  mock.module("node:child_process", () => ({
    ...childProcess,
    execFile: execFileMock,
    spawnSync: (command: string, args: string[], options: object) => {
      calls.push({ command, args, options });
      return originalSpawnSync(command, args, options);
    },
    execFileSync: (command: string, args: string[], options: object) => {
      calls.push({ command, args, options });
      return originalExecFileSync(command, args, options);
    },
  }));
  const { createReflectionMemoryWorktree } = await import("./memory-worktree");
  const { hasRootMemoryMarker } = await import("./memory-git-hooks");
  const { validateMemoryConstraintsHead } = await import(
    "./memory-constraints-audit"
  );
  const { runGitSafe } = await import("@/web/generate-memory-viewer");
  const root = mkdtempSync(join(tmpdir(), "memory-git-hide-"));
  const agentId = "agent-local-windows-hide";
  const repo = join(root, "agents", agentId, "memory");
  const originalConfigDir = process.env.LETTA_CONFIG_DIR;
  const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
  const originalLocalBackendExperimental =
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  try {
    process.env.LETTA_CONFIG_DIR = root;
    mkdirSync(repo, { recursive: true });
    originalExecFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    originalExecFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ],
      { cwd: repo },
    );
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "notes.md"), "A note\n");
    originalExecFileSync("git", ["add", "."], { cwd: repo });
    originalExecFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "memory",
      ],
      { cwd: repo },
    );
    await createReflectionMemoryWorktree({ parentMemoryDir: repo });
    hasRootMemoryMarker(repo);
    expect((await runGitSafe(repo, ["rev-parse", "HEAD"])).trim()).toHaveLength(
      40,
    );
    expect(validateMemoryConstraintsHead(repo).valid).toBe(true);
    const { getCommittedMemfsRevision } = await import(
      "@/backend/local/system-prompt-compilation"
    );
    expect(getCommittedMemfsRevision(repo)).toHaveLength(40);
    const { handleMemoryProtocolCommand } = await import(
      "@/websocket/listener/commands/memory"
    );
    const { handleGitBranchCommand } = await import(
      "@/websocket/listener/commands/git-branches"
    );
    const responses: Array<{ type: string; success: boolean }> = [];
    let pending: Promise<unknown> = Promise.resolve();
    const context = {
      socket: {},
      runtime: {},
      safeSocketSend: (
        _socket: unknown,
        message: { type: string; success: boolean },
      ) => {
        responses.push(message);
      },
      runDetachedListenerTask: (
        _name: string,
        task: () => Promise<unknown>,
      ) => {
        pending = task();
      },
    };
    for (const command of [
      { type: "memory_history", request_id: "history", agent_id: agentId },
      {
        type: "memory_file_at_ref",
        request_id: "file",
        agent_id: agentId,
        file_path: "notes.md",
        ref: "HEAD",
      },
      {
        type: "memory_commit_diff",
        request_id: "diff",
        agent_id: agentId,
        sha: "HEAD",
      },
    ]) {
      expect(handleMemoryProtocolCommand(command, context as never)).toBe(true);
      await pending;
    }
    expect(
      handleGitBranchCommand(
        {
          type: "search_branches",
          request_id: "search",
          query: "main",
          cwd: repo,
        },
        context as never,
      ),
    ).toBe(true);
    await pending;
    expect(
      handleGitBranchCommand(
        {
          type: "checkout_branch",
          request_id: "checkout",
          branch: "main",
          cwd: repo,
        },
        context as never,
      ),
    ).toBe(true);
    await pending;
    expect(
      responses.slice(0, 5).map(({ type, success }) => [type, success]),
    ).toEqual([
      ["memory_history_response", true],
      ["memory_file_at_ref_response", true],
      ["memory_commit_diff_response", true],
      ["search_branches_response", true],
      ["checkout_branch_response", true],
    ]);
    for (const args of [
      ["log", "--max-count=50"],
      ["show", "HEAD:notes.md"],
      ["show", "HEAD", "--format="],
      ["branch", "-a"],
      ["checkout", "main"],
      ["rev-parse", "--verify", "HEAD"],
    ]) {
      expect(
        calls.some(
          (call) =>
            call.command === "git" &&
            args.every((arg) => call.args.includes(arg)),
        ),
      ).toBe(true);
    }
    const { seedPersonalityDefaultMemoryFiles } = await import(
      "./personality-default-files"
    );
    const { buildPersonalityTag } = await import("./personality-presets");
    const profileRepo = join(root, "profile-memory");
    mkdirSync(profileRepo);
    originalExecFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: profileRepo,
    });
    originalExecFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ],
      { cwd: profileRepo },
    );
    expect(
      (
        await seedPersonalityDefaultMemoryFiles({
          agentId,
          memoryDir: profileRepo,
          agentTags: [buildPersonalityTag("tutorial")],
          syncMode: "local",
        })
      ).seededPaths,
    ).toEqual(["profile.png"]);
    const brokenRepo = join(root, "broken");
    mkdirSync(brokenRepo);
    expect(
      (
        await seedPersonalityDefaultMemoryFiles({
          agentId: "agent-local-broken",
          memoryDir: brokenRepo,
          agentTags: [buildPersonalityTag("tutorial")],
          syncMode: "local",
        })
      ).errors.length,
    ).toBeGreaterThan(0);
    expect(
      calls.some(
        (call) =>
          call.args.includes("reset") && call.args.includes("profile.png"),
      ),
    ).toBe(true);

    const { getBackend, configureBackendMode } = await import("@/backend");
    const { settingsManager } = await import("@/settings-manager");
    const { ensureMemfsSyncedForAgent } = await import(
      "@/websocket/listener/memfs-sync"
    );
    originalExecFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        `https://api.letta.com/v1/git/${agentId}/state.git`,
      ],
      { cwd: repo },
    );
    const retrieve = spyOn(getBackend(), "retrieveAgent").mockResolvedValue({
      id: agentId,
      tags: ["git-memory-enabled"],
    } as never);
    const disabled = spyOn(
      settingsManager,
      "isMemfsExplicitlyDisabled",
    ).mockReturnValue(false);
    const filesystem = await import("@/agent/memory-filesystem");
    const apply = spyOn(filesystem, "applyMemfsFlags").mockRejectedValue(
      new Error("HTTP 403"),
    );
    try {
      expect(
        await ensureMemfsSyncedForAgent(
          { memfsSyncedAgents: new Map() } as never,
          agentId,
        ),
      ).toBe(false);
    } finally {
      retrieve.mockRestore();
      disabled.mockRestore();
      apply.mockRestore();
    }
    expect(
      calls.some(
        (call) => call.args.includes("get-url") && call.args.includes("origin"),
      ),
    ).toBe(true);

    const localAgentId = "agent-local-personality-windows-hide";
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = join(root, "backend");
    configureBackendMode("local");
    const localRepo = join(root, "backend", "memfs", localAgentId, "memory");
    mkdirSync(join(localRepo, "notes"), { recursive: true });
    originalExecFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: localRepo,
    });
    writeFileSync(join(localRepo, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(localRepo, "persona.md"),
      "---\nname: Persona\ndescription: Who I am\n---\n\nOld persona.\n",
    );
    writeFileSync(
      join(localRepo, "notes", "MEMORY.md"),
      "# Notes\n\nSaved notes.\n",
    );
    originalExecFileSync("git", ["add", "."], { cwd: localRepo });
    originalExecFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: localRepo },
    );
    const { setCurrentAgentId } = await import("./context");
    const { memory } = await import("@/tools/impl/memory");
    setCurrentAgentId(localAgentId);
    try {
      expect((await memory({ path: "notes" })).content).toContain(
        "Saved notes.",
      );
    } finally {
      setCurrentAgentId(null);
    }
    const { applyPersonalityToMemory } = await import("./personality");
    expect(
      (
        await applyPersonalityToMemory({
          agentId: localAgentId,
          personalityId: "linus",
        })
      ).changed,
    ).toBe(true);
    const rejectingHooks = join(root, "rejecting-hooks");
    mkdirSync(rejectingHooks);
    writeFileSync(join(rejectingHooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    originalExecFileSync("git", ["config", "core.hooksPath", rejectingHooks], {
      cwd: localRepo,
    });
    await expect(
      applyPersonalityToMemory({
        agentId: localAgentId,
        personalityId: "memo",
      }),
    ).rejects.toThrow();
    expect(
      calls.some(
        (call) =>
          call.args.includes("status") && call.options.cwd === localRepo,
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.args.includes("reset") && call.options.cwd === localRepo,
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.args.includes("log") && call.args.includes("profile.png"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ command, args }) => command === "git" && args.includes("worktree"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ command, args }) => command === "git" && args.includes("read-tree"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ command, args }) => command === "git" && args.includes("cat-file"),
      ),
    ).toBe(true);
    expect(calls.some(({ command }) => command === process.execPath)).toBe(
      true,
    );
    expect(calls.every((call) => call.options.windowsHide === true)).toBe(true);
  } finally {
    mock.restore();
    const { configureBackendMode } = await import("@/backend");
    configureBackendMode("api");
    if (originalConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = originalConfigDir;
    if (originalLocalBackendDir === undefined)
      delete process.env.LETTA_LOCAL_BACKEND_DIR;
    else process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
    if (originalLocalBackendExperimental === undefined)
      delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    else
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL =
        originalLocalBackendExperimental;
    rmSync(root, { recursive: true, force: true });
  }
});
