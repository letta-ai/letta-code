import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installPreCommitHook } from "@/agent/memory-git-hooks";
import { executeToolScript } from "@/tools/workflow/workflow-engine";
import { loadHarnessSnapshot } from "./harness";
import { type MemoryHandleContext, openMemoryHandle } from "./memory-handle";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

const FILES: Record<string, string> = {
  "MEMORY.md": "# Memory\n\n- `reference` — design notes.\n",
  "persona.md": "---\nname: persona\ndescription: Who I am.\n---\nDry.\n",
  "human.md": "---\nname: human\ndescription: The user.\n---\nSarah.\n",
  "reference/MEMORY.md": "# Reference\n",
  "reference/design.md":
    "---\nname: design\ndescription: Design notes.\n---\nUse git.\n",
  "skills/greet/SKILL.md":
    "---\nname: greet\ndescription: Say hello.\n---\nWave.\n",
  "skills/greet/scripts/hello.sh": "echo hello\n",
};

function memoryRepo(files = FILES): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@letta.com");
  git(dir, "config", "user.name", "Test");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  installPreCommitHook(dir, true);
  return dir;
}

const context: MemoryHandleContext = {
  cwd: tmpdir(),
  agentId: "agent-test",
  agentName: "Tester",
  checkRead: async () => {},
  checkWrite: async () => {},
};

describe("harness snapshot", () => {
  test("classifies the index, core blocks, deferred memory, and skills", async () => {
    const dir = memoryRepo();
    const h = await loadHarnessSnapshot(await openMemoryHandle(dir, context));

    expect(h.revision).toBe(git(dir, "rev-parse", "HEAD"));
    expect(h.index).toBe(FILES["MEMORY.md"] as string);
    expect(Object.keys(h.core).sort()).toEqual(["human", "persona"]);
    expect(h.core.persona).toEqual({
      name: "persona",
      description: "Who I am.",
      body: "Dry.",
      path: "persona.md",
    });
    expect(h.memory.list()).toEqual([
      "reference/MEMORY.md",
      "reference/design.md",
    ]);
    expect(await h.memory.get("reference/design.md")).toMatchObject({
      description: "Design notes.",
      body: "Use git.",
    });
    expect(await h.memory.get("persona.md")).toBeNull();
    expect(h.skills.greet).toMatchObject({
      description: "Say hello.",
      files: ["skills/greet/SKILL.md", "skills/greet/scripts/hello.sh"],
    });
  });

  test("edit() commits typed changes to a new branch and leaves main alone", async () => {
    const dir = memoryRepo();
    const main = git(dir, "rev-parse", "HEAD");
    const h = await loadHarnessSnapshot(await openMemoryHandle(dir, context));

    const result = await h
      .edit({ message: "dream" })
      .core.put("persona", { description: "Who I am.", body: "Drier." })
      .core.delete("human")
      .memory.put("reference/new.md", { description: "New.", body: "x" })
      .skills.delete("greet")
      .skills.put("plan", {
        description: "Plan work.",
        body: "Steps.",
        files: { "notes.md": "n\n" },
      })
      .index.set("# Memory\n")
      .send();

    expect(result.branch).toMatch(/^harness\/edit-/);
    expect(result.base).toBe(main);
    expect(git(dir, "rev-parse", "main")).toBe(main);
    const proposed = await loadHarnessSnapshot(
      await openMemoryHandle(dir, context),
      result.branch,
    );
    expect(proposed.core.persona?.body).toBe("Drier.");
    expect(proposed.core.human).toBeUndefined();
    expect(proposed.index).toBe("# Memory\n");
    expect(Object.keys(proposed.skills)).toEqual(["plan"]);
    expect(proposed.skills.plan?.files).toEqual([
      "skills/plan/SKILL.md",
      "skills/plan/notes.md",
    ]);
    expect(proposed.memory.list("reference")).toContain("reference/new.md");
  });

  test("rejects invalid typed writes before committing", async () => {
    const dir = memoryRepo();
    const h = await loadHarnessSnapshot(await openMemoryHandle(dir, context));
    const edit = () => h.edit({ branch: "proposal/x" });

    expect(() => h.edit({ branch: "main" })).toThrow(/writes to a branch/);
    expect(() =>
      edit().core.put("MEMORY", { description: "d", body: "" }),
    ).toThrow(/index/);
    expect(() =>
      edit().core.put("persona", { description: "", body: "" }),
    ).toThrow(/description/);
    expect(() =>
      edit().core.put("persona", { description: "a\nb", body: "" }),
    ).toThrow(/single line/);
    expect(() =>
      edit().memory.put("top.md", { description: "d", body: "" }),
    ).toThrow(/inside a directory/);
    expect(() => edit().index.set("---\nname: x\n---\n")).toThrow(
      /frontmatter/,
    );
    expect(() =>
      edit().skills.put("Bad_Name", { description: "d", body: "" }),
    ).toThrow(/skill name/);
    await expect(
      edit().memory.put("notes/a.md", { description: "d", body: "" }).send(),
    ).rejects.toThrow(/add notes\/MEMORY.md/);
    expect(git(dir, "branch", "--list", "proposal/x")).toBe("");
  });

  test("requires the v2 layout", async () => {
    const dir = memoryRepo({
      "system/persona.md": "---\ndescription: Who I am.\n---\nDry.\n",
    });
    await expect(
      loadHarnessSnapshot(await openMemoryHandle(dir, context)),
    ).rejects.toThrow(/MemFS v2/);
  });
});

describe("script harness global", () => {
  test("scripts load an agent's harness through the scope binding", async () => {
    const dir = memoryRepo();
    const opened: unknown[] = [];
    const result = await executeToolScript({
      script: `
        const h = await harness.load('agent-x')
        const e = await h.edit({ branch: 'proposal/s' })
          .core.put('persona', { description: 'Who I am.', body: 'Scripted.' })
          .send()
        return { core: Object.keys(h.core), branch: e.branch, changed: e.changed }
      `,
      openMemory: async (target) => {
        opened.push(target);
        return openMemoryHandle(dir, context);
      },
    });
    expect(opened).toEqual([{ agentId: "agent-x" }]);
    expect(result).toEqual({
      core: ["human", "persona"],
      branch: "proposal/s",
      changed: true,
    });
  });
});
