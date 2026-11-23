import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeRepositorySkills } from "./claude-repository-skills";
import { buildClaudeStreamArgs } from "./claude-stream-session";

test("Claude adds scoped skill overlays for native and .agents repositories", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "claude-repo-skills-test-"));
  try {
    const first = join(scratch, "first");
    const second = join(scratch, "second");
    const sources = [
      join(first, ".claude", "skills"),
      join(second, ".agents", "skills"),
    ] as const;
    for (const source of sources) await mkdir(source, { recursive: true });
    const staged = await stageClaudeRepositorySkills([first, second]);
    try {
      const args = buildClaudeStreamArgs({
        skillDirectories: staged.directories,
      });
      expect(args.slice(args.indexOf("--add-dir") + 1)).toEqual(
        staged.directories,
      );
      const links = staged.directories.map((dir) =>
        join(dir, ".claude", "skills"),
      );
      if (process.platform === "win32") {
        expect(await Promise.all(links.map((link) => realpath(link)))).toEqual(
          await Promise.all(sources.map((source) => realpath(source))),
        );
      } else {
        expect(await Promise.all(links.map((link) => readlink(link)))).toEqual([
          sources[0],
          join(first, ".agents", "skills"),
          join(second, ".claude", "skills"),
          sources[1],
        ]);
      }
    } finally {
      await staged.cleanup();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "Claude skill overlays resolve after a late checkout",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "claude-late-repo-"));
    const repo = join(scratch, "repo");
    try {
      const staged = await stageClaudeRepositorySkills([repo]);
      try {
        const target = join(repo, ".agents", "skills");
        const links = staged.directories.map((dir) =>
          join(dir, ".claude", "skills"),
        );
        expect(links).toHaveLength(2);
        await mkdir(target, { recursive: true });
        const resolved = await Promise.allSettled(
          links.map((link) => realpath(link)),
        );
        expect(resolved[1]).toEqual({
          status: "fulfilled",
          value: await realpath(target),
        });
      } finally {
        await staged.cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test("Claude skips missing skills directories on Windows", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "claude-missing-repo-"));
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const staged = await stageClaudeRepositorySkills([join(scratch, "repo")]);
    try {
      expect(staged.directories).toEqual([]);
    } finally {
      await staged.cleanup();
    }
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    await rm(scratch, { recursive: true, force: true });
  }
});
