import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installPreCommitHook } from "@/agent/memory-git-hooks";
import { LocalStore } from "@/backend/local/local-store";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { initGitRepo } from "@/test-utils/temp-git-repo";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

/** A one-shot primary turn on the local backend, returning exit code and output. */
async function runTurn(
  home: string,
  storageDir: string,
  conversationId: string,
) {
  const invocation = process.env.LETTA_TEST_BUILT_CLI
    ? ["node", process.env.LETTA_TEST_BUILT_CLI]
    : [
        process.execPath,
        `--config=${resolve(import.meta.dir, "..", "bunfig.toml")}`,
        resolve(import.meta.dir, "index.ts"),
      ];
  const child = Bun.spawn(
    [
      ...invocation,
      "--backend",
      "local",
      "--conversation",
      conversationId,
      "-p",
      "Continue the user task.",
      "--tools=",
      "--no-skills",
      "--no-system-info-reminder",
      // Text output keeps stderr, where a one-shot run reports memory state.
      "--output-format",
      "text",
    ],
    {
      cwd: home,
      env: createIsolatedCliTestEnv({
        HOME: home,
        USER_CWD: home,
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
        LETTA_LOCAL_BACKEND_DIR: storageDir,
        LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
        LETTA_SKIP_KEYCHAIN_CHECK: "1",
        LETTA_DISABLE_MODS: "1",
        LETTA_FS_SANDBOX: "0",
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  } finally {
    clearTimeout(deadline);
  }
}

test("a headless turn that leaves memory uncommitted ends with it committed as the agent", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-memory-leftovers-"));
  try {
    const storageDir = join(home, "store");
    const agentId = "local-agent-memory-leftovers";
    const store = new LocalStore(agentId, {
      storageDir,
      defaultAgentModel: "anthropic/claude-sonnet-4-6",
    });
    const conversation = store.createConversation({ agent_id: agentId });
    const memoryDir = getLocalBackendMemoryFilesystemRoot(agentId, storageDir);
    mkdirSync(join(memoryDir, "system"), { recursive: true });
    const { git } = initGitRepo(memoryDir);
    writeFileSync(
      join(memoryDir, "system", "user.md"),
      "---\ndescription: The user\n---\n\nOriginal.\n",
    );
    git("add", "system/user.md");
    git("commit", "-m", "initial");
    installPreCommitHook(memoryDir, true);
    // The agent edited memory directly during the turn and never ran Git.
    writeFileSync(
      join(memoryDir, "system", "user.md"),
      "---\ndescription: The user\n---\n\nPrefers tabs.\n",
    );
    writeFileSync(
      join(memoryDir, "system", "broken.md"),
      "no frontmatter, so the hook rejects this one\n",
    );

    const first = await runTurn(home, storageDir, conversation.id);
    expect(first.code, first.output).toBe(0);
    // The hook rejected the whole commit; nothing is saved yet and the
    // reason reaches stderr (a one-shot run has no next turn to remind).
    expect(git("log", "--format=%s")).toBe("initial");
    expect(first.output).toContain("MEMORY COMMIT NEEDED");
    expect(first.output).toContain("broken.md");

    rmSync(join(memoryDir, "system", "broken.md"));
    const second = await runTurn(home, storageDir, conversation.id);
    expect(second.code, second.output).toBe(0);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "-1", "--format=%s")).toContain("left after the turn");
    expect(git("log", "-1", "--format=%ae")).toBe(`${agentId}@letta.com`);
    expect(second.output).not.toContain("MEMORY COMMIT NEEDED");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
