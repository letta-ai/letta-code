import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPreCommitHook } from "@/agent/memory-git-hooks";
import { executeToolScript } from "@/tools/workflow/workflow-engine";
import {
  type MemoryHandleContext,
  type MemoryWriteTarget,
  openMemoryHandle,
} from "./memory-handle";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function memoryRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-handle-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@letta.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
  writeFileSync(
    join(dir, "persona.md"),
    "---\nname: persona\ndescription: Who I am.\n---\nI am a test agent.\n",
  );
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  installPreCommitHook(dir, true);
  return dir;
}

function context(writes: MemoryWriteTarget[] = []): MemoryHandleContext {
  return {
    cwd: tmpdir(),
    agentId: "agent-test",
    agentName: "Tester",
    checkRead: async () => {},
    checkWrite: async (target) => {
      writes.push(target);
    },
  };
}

describe("memory handle over a local repository", () => {
  test("reads, commits to main through hooks, and logs/diffs branches", async () => {
    const dir = memoryRepo();
    const writes: MemoryWriteTarget[] = [];
    const memory = await openMemoryHandle(dir, context(writes));

    expect(await memory.list()).toEqual(["MEMORY.md", "persona.md"]);
    expect(await memory.read("MEMORY.md")).toBe("# Memory\n");
    expect(await memory.read("missing.md")).toBeNull();

    // A dirty, unrelated working-tree edit must survive and stay unstaged.
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\nlocal draft\n");
    const committed = await memory
      .commit({ message: "add notes" })
      .put(
        "notes.md",
        "---\nname: notes\ndescription: Notes.\n---\nRemember this.\n",
      )
      .send();
    expect(committed).toMatchObject({ branch: "main", changed: true });
    expect(git(dir, "rev-parse", "HEAD")).toBe(committed.sha);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toContain("Remember");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("draft");
    expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe(
      "Tester <agent-test@letta.com>",
    );
    expect(writes).toEqual([
      { path: dir, branch: "main", paths: ["notes.md"] },
    ]);

    // Branch commits leave the checkout alone and are visible via ref reads.
    const proposal = await memory
      .commit({ message: "propose", branch: "proposals/a" })
      .put(
        "persona.md",
        "---\nname: persona\ndescription: Who I am.\n---\nChanged.\n",
      )
      .delete("notes.md")
      .send();
    expect(git(dir, "rev-parse", "HEAD")).toBe(committed.sha);
    expect(git(dir, "rev-parse", "proposals/a")).toBe(proposal.sha);
    expect(await memory.read("notes.md", { ref: "proposals/a" })).toBeNull();
    const diff = await memory.diff({ ref: "proposals/a" });
    expect(diff.map(({ path, state }) => ({ path, state }))).toEqual([
      { path: "notes.md", state: "deleted" },
      { path: "persona.md", state: "modified" },
    ]);
    expect(diff[1]?.patch).toContain("+Changed.");
    const log = await memory.log({ ref: "proposals/a", limit: 2 });
    expect(log.map((entry) => entry.message)).toEqual(["propose", "add notes"]);
    expect(log[0]?.email).toBe("agent-test@letta.com");
  });

  test("the repository's pre-commit hook rejects invalid memory", async () => {
    const dir = memoryRepo();
    const head = git(dir, "rev-parse", "HEAD");
    const memory = await openMemoryHandle(dir, context());
    await expect(
      memory
        .commit({ message: "bad" })
        .put("bad.md", "no frontmatter\n")
        .send(),
    ).rejects.toThrow();
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("permission denial prevents the commit", async () => {
    const dir = memoryRepo();
    const head = git(dir, "rev-parse", "HEAD");
    const memory = await openMemoryHandle(dir, {
      ...context(),
      checkWrite: async () => {
        throw new Error("memory write to x.md is denied");
      },
    });
    await expect(
      memory.commit({ message: "x" }).put("x.md", "x").send(),
    ).rejects.toThrow("denied");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  });

  test("rejects paths that escape the repository", async () => {
    const memory = await openMemoryHandle(memoryRepo(), context());
    expect(() => memory.commit({ message: "x" }).put("../x.md", "x")).toThrow(
      "inside the repository",
    );
    expect(() => memory.commit({ message: "x" }).delete(".git/config")).toThrow(
      ".git",
    );
  });
});

describe("script memory global", () => {
  test("CodeMode scripts reach memory.open through the scope binding", async () => {
    const dir = memoryRepo();
    const result = await executeToolScript({
      script: `const m = await memory.open(args.dir)
const r = await m.commit({ message: 'from script', branch: 'scripted' }).put('MEMORY.md', '# Changed\\n').send()
return { before: await m.read('MEMORY.md'), after: await m.read('MEMORY.md', { ref: r.branch }) }`,
      args: { dir },
      openMemory: (target) => openMemoryHandle(target, context()),
    });
    expect(result).toEqual({ before: "# Memory\n", after: "# Changed\n" });
  });

  test("memory.open fails clearly without an invoking scope", async () => {
    await expect(
      executeToolScript({ script: "return memory.open('.')" }),
    ).rejects.toThrow("memory is unavailable");
  });
});
