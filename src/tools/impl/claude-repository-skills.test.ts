import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeRepositorySkills } from "./claude-repository-skills";

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
