import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claimMemoryOperation } from "@/agent/memory-operation";
import { initGitRepo, type TempGitRepo } from "@/test-utils/temp-git-repo";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const agentId = "agent-00000000-0000-4000-8000-000000000001";
let home: string;
let remote: string;
let memory: string;
let repo: TempGitRepo;
let hostedRevision: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memory-reset-"));
  remote = join(home, "hosted", "v1", "git", agentId, "state.git");
  memory = join(home, ".letta", "agents", agentId, "memory");
  mkdirSync(dirname(remote), { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], {
    stdio: "ignore",
  });
  mkdirSync(memory, { recursive: true });
  repo = initGitRepo(memory);
  writeFileSync(join(memory, "MEMORY.md"), "# Initial\n");
  repo.git("add", "MEMORY.md");
  repo.git("commit", "-qm", "initial");
  repo.git("remote", "add", "origin", remote);
  repo.git("push", "-u", "origin", "main");
  repo.git("checkout", "-qb", "hosted");
  writeFileSync(join(memory, "MEMORY.md"), "# Hosted\n");
  repo.git("commit", "-qam", "hosted memory");
  repo.git("push", "origin", "hosted:main");
  hostedRevision = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  writeFileSync(join(memory, "MEMORY.md"), "# Local\n");
  repo.git("commit", "-qam", "unpushed memory");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const invocation = process.env.LETTA_TEST_BUILT_CLI
    ? ["node", process.env.LETTA_TEST_BUILT_CLI]
    : [
        process.execPath,
        `--config=${resolve("bunfig.toml")}`,
        resolve("src/index.ts"),
      ];
  const child = Bun.spawn(
    [...invocation, "memory", ...args, "--agent", agentId],
    {
      cwd: home,
      env: createIsolatedCliTestEnv({
        HOME: home,
        LETTA_API_KEY: "memory-reset-test-token",
        LETTA_MEMFS_BASE_URL: join(home, "hosted"),
        LETTA_MEMFS_GIT_PROXY_BASE_URL: undefined,
        LETTA_DISABLE_MODS: "1",
        LETTA_SKIP_KEYCHAIN_CHECK: "1",
        ...extraEnv,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
  }
}

function conflict(operation: "merge" | "rebase" = "rebase") {
  expect(() => repo.git(operation, "origin/main")).toThrow();
  writeFileSync(join(memory, "pending.md"), "uncommitted memory\n");
  writeFileSync(join(memory, ".git", "info", "exclude"), "ignored.md\n");
  writeFileSync(join(memory, "ignored.md"), "ignored memory\n");
  writeFileSync(
    join(memory, ".git", "letta-memory-repair.json"),
    JSON.stringify({ state: "done", token: "failed-attempt" }),
  );
}

test.each(["rebase", "merge"] as const)(
  "reset recovers an unfinished %s, backs up local work, and leaves hosted memory unchanged",
  async (operation) => {
    conflict(operation);
    if (operation === "merge")
      repo.git("remote", "set-url", "origin", join(home, "stale-origin"));
    const before = readFileSync(join(memory, "MEMORY.md"), "utf8");
    const result = await cli(["reset", "--force"]);
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.revision).toBe(hostedRevision);
    expect(repo.git("rev-parse", "HEAD")).toBe(hostedRevision);
    expect(repo.git("symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(repo.git("rev-parse", "@{u}")).toBe(hostedRevision);
    expect(repo.git("remote", "get-url", "origin")).toBe(remote);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("# Hosted\n");
    for (const path of [
      "pending.md",
      "ignored.md",
      ".git/rebase-merge",
      ".git/rebase-apply",
      ".git/MERGE_HEAD",
      ".git/letta-memory-repair.json",
      ".git/letta-memory-operation.lock",
    ]) {
      expect(existsSync(join(memory, path)), path).toBe(false);
    }
    expect(readFileSync(join(output.backupPath, "MEMORY.md"), "utf8")).toBe(
      before,
    );
    expect(readFileSync(join(output.backupPath, "pending.md"), "utf8")).toBe(
      "uncommitted memory\n",
    );
    expect(readFileSync(join(output.backupPath, "ignored.md"), "utf8")).toBe(
      "ignored memory\n",
    );
    expect(
      existsSync(join(output.backupPath, ".git/letta-memory-operation.lock")),
    ).toBe(false);
    expect(
      execFileSync("git", ["-C", output.backupPath, "show", "main:MEMORY.md"], {
        encoding: "utf8",
      }),
    ).toBe("# Local\n");
    expect(
      execFileSync("git", ["-C", remote, "rev-parse", "main"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(hostedRevision);
    expect((await cli(["status"])).code).toBe(0);
    const backups = JSON.parse((await cli(["backups"])).stdout).backups;
    expect(backups.map((backup: { path: string }) => backup.path)).toContain(
      output.backupPath,
    );
  },
  30_000,
);

test("reset validates the fetched configuration, not an invalid local commit", async () => {
  writeFileSync(join(memory, ".memfs.config.json"), "invalid local config");
  repo.git("add", ".memfs.config.json");
  repo.git("commit", "-qm", "invalid local memory");
  repo.git("checkout", "-q", "hosted");
  writeFileSync(
    join(memory, ".memfs.config.json"),
    JSON.stringify({ version: 1, maxFileCharacters: 10_000 }),
  );
  repo.git("add", ".memfs.config.json");
  repo.git("commit", "-qm", "hosted limits");
  repo.git("push", "origin", "hosted:main");
  hostedRevision = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  const result = await cli(["reset", "--force"]);
  expect(result.code, result.stderr).toBe(0);
  expect(repo.git("rev-parse", "HEAD")).toBe(hostedRevision);
  expect(
    readFileSync(
      join(JSON.parse(result.stdout).backupPath, ".memfs.config.json"),
      "utf8",
    ),
  ).toBe("invalid local config");
}, 30_000);

test.each([
  "confirmation",
  "busy",
  "offline",
  "invalid",
  "local",
  "missing-main",
])(
  "reset refuses %s without discarding the conflicted checkout",
  async (failure) => {
    if (failure === "invalid") {
      repo.git("checkout", "-q", "hosted");
      writeFileSync(join(memory, "oversized.md"), "x".repeat(20_001));
      repo.git("add", "oversized.md");
      repo.git("commit", "-qm", "invalid hosted tree");
      repo.git("push", "origin", "hosted:main");
      repo.git("checkout", "-q", "main");
    }
    conflict();
    const before = readFileSync(join(memory, "MEMORY.md"), "utf8");
    const head = repo.git("rev-parse", "HEAD");
    const status = repo.git("status", "--porcelain");
    const release =
      failure === "busy" ? await claimMemoryOperation(memory) : undefined;
    if (failure === "offline") renameSync(remote, `${remote}-offline`);
    if (failure === "missing-main")
      execFileSync("git", [
        "-C",
        remote,
        "update-ref",
        "-d",
        "refs/heads/main",
      ]);
    try {
      const result = await cli(
        failure === "confirmation" ? ["reset"] : ["reset", "--force"],
        failure === "local" ? { LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1" } : {},
      );
      expect(result.code, result.stdout).toBe(1);
      expect(result.stderr).toContain(
        {
          confirmation: "--force",
          busy: "another memory operation",
          offline: "does not appear to be a git repository",
          invalid: "fails validation",
          local: "hosted memory",
          "missing-main": "remote ref",
        }[failure] ?? "",
      );
      expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe(before);
      expect(repo.git("rev-parse", "HEAD")).toBe(head);
      expect(repo.git("status", "--porcelain")).toBe(status);
      expect(existsSync(join(memory, ".git", "letta-memory-repair.json"))).toBe(
        true,
      );
      expect(
        readdirSync(dirname(memory)).filter((name) =>
          name.startsWith("memory-backup-"),
        ),
      ).toEqual([]);
    } finally {
      await release?.();
    }
  },
  30_000,
);
