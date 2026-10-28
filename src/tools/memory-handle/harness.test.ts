import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installPreCommitHook } from "@/agent/memory-git-hooks";
import { executeToolScript } from "@/tools/workflow/workflow-engine";
import {
  acceptHarness,
  diffHarness,
  loadHarnessSnapshot,
  swap,
} from "./harness";
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
  "MEMORY.md": "# Memory\n\n- [Reference](reference/MEMORY.md) — notes.\n",
  "persona.md": "---\nname: persona\ndescription: Who I am.\n---\nDry.\n",
  "human.md": "---\nname: human\ndescription: The user.\n---\nSarah.\n",
  "reference/MEMORY.md":
    "# Reference\n\n- [Design](reference/design.md)\n- [External](external/MEMORY.md)\n",
  "reference/design.md":
    "---\nname: design\ndescription: Design notes.\n---\nUse git.\n",
  "reference/external/MEMORY.md": "# External\n",
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

async function load(dir: string, ref?: string) {
  return loadHarnessSnapshot(await openMemoryHandle(dir, context), ref);
}

describe("harness reads", () => {
  test("prompts, the memory tree, and skills", async () => {
    const dir = memoryRepo();
    const h = await load(dir);

    expect(h.revision).toBe(git(dir, "rev-parse", "HEAD"));
    expect(h.prompts.get("persona")).toEqual({
      path: "persona",
      name: "persona",
      description: "Who I am.",
      body: "Dry.",
    });
    expect(
      (h.prompts.get() as { files: readonly { path: string }[] }).files.map(
        (file) => file.path,
      ),
    ).toEqual(["human", "persona"]);

    expect(h.memory.get("")).toEqual({
      path: "",
      body: FILES["MEMORY.md"] as string,
      files: [],
      directories: [{ path: "reference" }],
    });
    expect(h.memory.get("reference")).toEqual({
      path: "reference",
      body: FILES["reference/MEMORY.md"] as string,
      files: [
        {
          path: "reference/design",
          name: "design",
          description: "Design notes.",
        },
      ],
      directories: [{ path: "reference/external" }],
    });
    expect(h.memory.get("reference/design")).toMatchObject({
      body: "Use git.",
    });
    expect(h.memory.get("reference/missing")).toBeNull();
    expect(() => h.memory.get("reference/design.md")).toThrow(/no .md/);

    expect(h.skills.get()).toEqual({ directories: [{ path: "greet" }] });
    expect(h.skills.get("greet")).toMatchObject({
      description: "Say hello.",
      body: "Wave.",
      files: ["scripts/hello.sh"],
    });
    expect(h.skills.get("greet/scripts/hello.sh")).toBe("echo hello\n");
  });

  test("requires the v2 layout", async () => {
    const dir = memoryRepo({
      "system/persona.md": "---\ndescription: Who I am.\n---\nDry.\n",
    });
    await expect(load(dir)).rejects.toThrow(/MemFS v2/);
  });
});

describe("harness edits", () => {
  test("stage get/put/update/delete across namespaces and commit to a branch", async () => {
    const dir = memoryRepo();
    const main = git(dir, "rev-parse", "HEAD");
    const h = await load(dir);
    const e = h.edit();

    e.prompts
      .update("persona", (p: { body: string }) => ({
        ...p,
        body: swap(p.body, "Dry.", "Drier."),
      }))
      .prompts.delete("human")
      .memory.put("projects", {
        directory: true,
        body: "# Projects\n\n- [harness](projects/harness.md)",
      })
      .memory.put("projects/harness", { description: "API design.", body: "x" })
      .memory.update("", (d: { body: string }) => ({
        ...d,
        body: `${d.body}- [Projects](projects/MEMORY.md)\n`,
      }))
      .skills.update("greet/scripts/hello.sh", (t: string) =>
        swap(t, "hello", "hi"),
      )
      .skills.put("plan", { description: "Plan work.", body: "Steps." })
      .skills.put("plan/notes.md", "n\n");

    // Reads see staged writes.
    expect(e.prompts.get("persona")).toMatchObject({ body: "Drier." });
    expect(e.memory.get("projects")).toMatchObject({
      files: [{ path: "projects/harness" }],
    });
    expect(h.memory.get("projects")).toBeNull();

    const preview = e.diff();
    expect(preview.changes.map((change) => [change.path, change.op])).toEqual([
      ["MEMORY.md", "modify"],
      ["human.md", "delete"],
      ["persona.md", "modify"],
      ["projects/MEMORY.md", "add"],
      ["projects/harness.md", "add"],
      ["skills/greet/scripts/hello.sh", "modify"],
      ["skills/plan/SKILL.md", "add"],
      ["skills/plan/notes.md", "add"],
    ]);
    expect(preview.text).toContain("+Drier.");
    expect(preview.links).toEqual([]);

    const result = await e.commit("dream");
    expect(result.branch).toMatch(/^harness\/edit-/);
    expect(result.base).toBe(main);
    expect(result.changed).toHaveLength(8);
    expect(git(dir, "rev-parse", "main")).toBe(main);
    expect(git(dir, "log", "-1", "--format=%s", result.branch)).toBe("dream");

    const proposed = await load(dir, result.branch);
    expect(proposed.prompts.get("human")).toBeNull();
    expect(proposed.memory.get("projects/harness")).toMatchObject({
      description: "API design.",
    });
    expect(proposed.skills.get("plan")).toMatchObject({ files: ["notes.md"] });
    expect(proposed.skills.get("greet/scripts/hello.sh")).toBe("echo hi\n");
    expect(() => e.commit()).toThrow(/already committed/);
  });

  test("put replaces only the node's own document", async () => {
    const dir = memoryRepo();
    const e = (await load(dir)).edit();
    e.memory.put("reference", { body: "# Reference v2\n" });
    expect(e.memory.get("reference")).toMatchObject({
      body: "# Reference v2\n",
      files: [{ path: "reference/design" }],
      directories: [{ path: "reference/external" }],
    });
    e.skills.put("greet", { description: "Say hi.", body: "Wave." });
    expect(e.skills.get("greet")).toMatchObject({
      files: ["scripts/hello.sh"],
    });
  });

  test("delete requires recursive for non-empty directories and skills", async () => {
    const dir = memoryRepo();
    const e = (await load(dir)).edit();
    expect(() => e.memory.delete("reference")).toThrow(/recursive/);
    expect(() => e.skills.delete("greet")).toThrow(/recursive/);
    e.memory.delete("reference/external");
    e.memory.delete("reference", { recursive: true });
    e.skills.delete("greet", { recursive: true });
    expect(e.memory.get("reference")).toBeNull();
    expect(e.skills.get("greet")).toBeNull();
    expect(e.diff().links).toEqual([
      { path: "", unlinked: [], dangling: ["reference/MEMORY.md"] },
    ]);
  });

  test("diff reports unlinked children and dangling links without blocking", async () => {
    const dir = memoryRepo();
    const e = (await load(dir)).edit();
    e.memory.put("reference/prime", { description: "Prime.", body: "" });
    e.memory.delete("reference/design");
    expect(e.diff().links).toEqual([
      {
        path: "reference",
        unlinked: ["reference/prime"],
        dangling: ["reference/design.md"],
      },
    ]);
    const result = await e.commit("drift");
    expect(result.links).toHaveLength(1);
  });

  test("rejects invalid writes when staged", async () => {
    const dir = memoryRepo();
    const h = await load(dir);
    const e = h.edit({ branch: "proposal/x" });

    expect(() => h.edit({ branch: "main" })).toThrow(/branch, not main/);
    expect(() =>
      e.prompts.put("MEMORY", { description: "d", body: "" }),
    ).toThrow(/reserved/);
    expect(() =>
      e.prompts.put("persona", { description: "", body: "" }),
    ).toThrow(/description/);
    expect(() =>
      e.prompts.put("persona", { description: "a\nb", body: "" }),
    ).toThrow(/single line/);
    expect(() => e.memory.put("notes", { description: "d", body: "" })).toThrow(
      /prompts/,
    );
    expect(() =>
      e.memory.put("notes/a", { description: "d", body: "" }),
    ).toThrow(/No directory notes/);
    expect(() =>
      e.memory.put("reference", { description: "d", body: "" }),
    ).toThrow(/no description/);
    expect(() =>
      e.memory.put("reference/external", { description: "d", body: "" }),
    ).toThrow(/no description/);
    expect(() =>
      e.memory.put("reference/design", { directory: true, body: "" }),
    ).toThrow(/is a file/);
    expect(() =>
      e.memory.put("x", { directory: true, body: "---\na: b\n---\n" }),
    ).toThrow(/frontmatter/);
    expect(() =>
      e.memory.update("reference/missing", (f: object) => f),
    ).toThrow(/Nothing to update/);
    expect(() => e.memory.delete("reference/missing")).toThrow(
      /No memory node/,
    );
    expect(() => e.memory.delete("")).toThrow(/root/);
    expect(() =>
      e.skills.put("Bad_Name", { description: "d", body: "" }),
    ).toThrow(/skill name/);
    expect(() => e.skills.put("nope/a.sh", "x")).toThrow(/No skill nope/);
    expect(() =>
      e.skills.put("greet", { name: "other", description: "d", body: "" }),
    ).toThrow(/match its folder/);
    expect(() => e.skills.put("greet/SKILL.md", "x")).toThrow(/skill path/);
    await expect(e.commit()).rejects.toThrow(/no changes/);
    expect(git(dir, "branch", "--list", "proposal/x")).toBe("");
  });

  test("a rejected commit keeps the staged edits for a retry", async () => {
    const dir = memoryRepo();
    let deny = true;
    const handle = await openMemoryHandle(dir, {
      ...context,
      checkWrite: async () => {
        if (deny) throw new Error("denied");
      },
    });
    const e = (await loadHarnessSnapshot(handle)).edit({
      branch: "proposal/r",
    });
    e.prompts.put("style", { description: "S.", body: "" });
    await expect(e.commit()).rejects.toThrow(/denied/);
    expect(e.prompts.get("style")).toMatchObject({ description: "S." });
    deny = false;
    const result = await e.commit();
    expect(result.changed).toEqual(["style.md"]);
    expect(() => e.prompts.delete("style")).toThrow(/already committed/);
  });

  test("refuses to commit onto a branch that moved past the edit's base", async () => {
    const dir = memoryRepo();
    const h = await load(dir);
    await h
      .edit({ branch: "proposal/y" })
      .prompts.put("style", { description: "S.", body: "" })
      .commit();
    await expect(
      h
        .edit({ branch: "proposal/y" })
        .prompts.put("style", { description: "T.", body: "" })
        .commit(),
    ).rejects.toThrow(/already exists/);
  });
});

type Doc = { name: string; description: string; body: string };

describe("concurrent edits", () => {
  test("diff, apply with line merges and conflicts, then accept main by compare-and-swap", async () => {
    const dir = memoryRepo();
    const handle = await openMemoryHandle(dir, context);
    const h = await loadHarnessSnapshot(handle);
    const design = (body: string) => ({
      name: "design",
      description: "Design notes.",
      body,
    });
    // Two workers branch from the same main and both touch reference/design.
    const a = await h
      .edit({ branch: "proposal/a" })
      .memory.put("reference/design", design("Use git.\nPrefer branches.\n"))
      .prompts.update("persona", (p: Doc) => ({ ...p, body: "Dry. Direct.\n" }))
      .commit("a");
    const b = await h
      .edit({ branch: "proposal/b" })
      .memory.put("reference/design", design("Always use git.\n"))
      .prompts.update("persona", (p: Doc) => ({ ...p, body: "Terse.\n" }))
      .prompts.put("style", { description: "Style.", body: "Short.\n" })
      .commit("b");

    const da = await diffHarness(handle, a.base, a.branch);
    expect(da.changes.map((c) => [c.path, c.op])).toEqual([
      ["persona.md", "modify"],
      ["reference/design.md", "modify"],
    ]);

    const merged = h.edit({ branch: "reconcile/1" });
    expect(merged.apply(da.changes)).toEqual({
      applied: ["persona.md", "reference/design.md"],
      merged: [],
      conflicts: [],
    });
    const db = await diffHarness(handle, b.base, b.branch);
    const result = merged.apply(db.changes);
    // design: a appended a line, b rewrote line 1 -> disjoint lines merge.
    expect(result.applied).toEqual(["style.md"]);
    expect(result.merged).toEqual(["reference/design.md"]);
    expect(merged.memory.get("reference/design")).toMatchObject({
      body: "Always use git.\nPrefer branches.",
    });
    // persona: both rewrote the same line -> conflict, ours left in place.
    expect(result.conflicts).toEqual([
      {
        path: "persona.md",
        base: FILES["persona.md"],
        ours: "---\nname: persona\ndescription: Who I am.\n---\nDry. Direct.\n",
        theirs: "---\nname: persona\ndescription: Who I am.\n---\nTerse.\n",
      },
    ]);
    merged.prompts.update("persona", (p: Doc) => ({
      ...p,
      body: "Dry. Terse.\n",
    }));
    const reconciled = await merged.commit("reconcile");

    // Someone else advances main first: accept refuses, nothing moves.
    const main = git(dir, "rev-parse", "main");
    expect(main).toBe(h.revision);
    await h
      .edit({ branch: "proposal/c" })
      .prompts.put("tone", { description: "T.", body: "" })
      .commit();
    git(dir, "merge", "-q", "--ff-only", "proposal/c");
    await expect(
      acceptHarness(handle, reconciled.branch, reconciled.base),
    ).rejects.toThrow(/moved/);
    expect(git(dir, "rev-parse", "main")).not.toBe(reconciled.sha);

    // Retry on the new head: reload, re-apply the reconciled changes, accept.
    const h2 = await loadHarnessSnapshot(handle);
    const retry = h2.edit({ branch: "reconcile/2" });
    const again = retry.apply(
      (await diffHarness(handle, reconciled.base, reconciled.branch)).changes,
    );
    expect(again.conflicts).toEqual([]);
    const r2 = await retry.commit("reconcile on new main");
    expect(await acceptHarness(handle, r2.branch, r2.base)).toEqual({
      sha: r2.sha,
      changed: true,
    });
    const final = await loadHarnessSnapshot(handle);
    expect(final.revision).toBe(r2.sha);
    expect(final.prompts.get("persona")).toMatchObject({
      body: "Dry. Terse.",
    });
    expect(final.prompts.get("tone")).toMatchObject({ description: "T." });
    expect(final.prompts.get("style")).toMatchObject({ body: "Short." });
  });

  test("accept refuses a ref that does not descend from expect", async () => {
    const dir = memoryRepo();
    const handle = await openMemoryHandle(dir, context);
    const h = await loadHarnessSnapshot(handle);
    git(dir, "checkout", "-q", "--orphan", "stray");
    git(dir, "commit", "-q", "--allow-empty", "-m", "stray");
    git(dir, "checkout", "-q", "main");
    await expect(acceptHarness(handle, "stray", h.revision)).rejects.toThrow(
      /does not descend/,
    );
  });

  test("apply leaves add/delete collisions as conflicts", () => {
    return (async () => {
      const h = await load(memoryRepo());
      const e = h.edit({ branch: "x" });
      e.prompts.put("style", { description: "Ours.", body: "" });
      const result = e.apply([
        {
          path: "style.md",
          op: "add",
          after: "---\nname: style\ndescription: Theirs.\n---\n",
        },
        { path: "human.md", op: "delete", before: "stale\n" },
      ]);
      expect(result.applied).toEqual([]);
      expect(result.conflicts.map((c) => c.path)).toEqual([
        "style.md",
        "human.md",
      ]);
      expect(e.prompts.get("style")).toMatchObject({ description: "Ours." });
      expect(e.prompts.get("human")).not.toBeNull();
    })();
  });
});

describe("swap", () => {
  test("replaces exactly one match unless all is set", () => {
    expect(swap("a b a", "b", "c")).toBe("a c a");
    expect(swap("a b a", "a", "$&", { all: true })).toBe("$& b $&");
    expect(() => swap("a b a", "a", "c")).toThrow(/2 times/);
    expect(() => swap("a b", "z", "c")).toThrow(/not found/);
  });
});

describe("script harness global", () => {
  test("scripts diff and accept through the scope binding", async () => {
    const dir = memoryRepo();
    const result = await executeToolScript({
      script: `
        const h = await harness.load('agent-x')
        const r = await h.edit({ branch: 'proposal/s' })
          .prompts.put('style', { description: 'S.', body: '' }).commit()
        const d = await harness.diff('agent-x', { base: r.base, ref: r.branch })
        const a = await harness.accept('agent-x', r.branch, { expect: r.base })
        return { ops: d.changes.map(c => c.op + ' ' + c.path), moved: a.sha === r.sha }
      `,
      openMemory: async () => openMemoryHandle(dir, context),
    });
    expect(result).toEqual({ ops: ["add style.md"], moved: true });
  });

  test("harness fails clearly without an invoking scope", async () => {
    await expect(
      executeToolScript({ script: "return harness.load('agent-x')" }),
    ).rejects.toThrow("harness is unavailable");
  });

  test("scripts load an agent's harness and swap through the scope binding", async () => {
    const dir = memoryRepo();
    const opened: unknown[] = [];
    const result = await executeToolScript({
      script: `
        const h = await harness.load('agent-x')
        const r = await h.edit({ branch: 'proposal/s' })
          .prompts.update('persona', p => ({ ...p, body: swap(p.body, 'Dry.', 'Scripted.') }))
          .commit('script')
        return { prompts: h.prompts.get().files.map(f => f.path), branch: r.branch, changed: r.changed }
      `,
      openMemory: async (target) => {
        opened.push(target);
        return openMemoryHandle(dir, context);
      },
    });
    expect(opened).toEqual([{ agentId: "agent-x" }]);
    await expect(
      executeToolScript({ script: "return typeof memory" }),
    ).resolves.toBe("undefined");
    expect(result).toEqual({
      prompts: ["human", "persona"],
      branch: "proposal/s",
      changed: ["persona.md"],
    });
  });
});
