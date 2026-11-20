import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeRepositorySkills } from "./claude-repository-skills";
import { buildClaudeStreamArgs } from "./claude-stream-args";

test("Claude adds scoped skill overlays for native and .agents repositories", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "claude-repo-skills-test-"));
  try {
    const first = join(scratch, "first");
    const second = join(scratch, "second");
    const sources = [
      join(first, ".claude", "skills"),
      join(second, ".agents", "skills"),
    ];
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
      expect(await Promise.all(links.map((link) => realpath(link)))).toEqual(
        await Promise.all(sources.map((source) => realpath(source))),
      );
    } finally {
      await staged.cleanup();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
