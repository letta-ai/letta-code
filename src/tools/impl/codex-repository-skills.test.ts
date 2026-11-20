import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCodexRepositorySkills } from "./codex-repository-skills";

test("registers missing skill roots and refreshes once when they appear", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "codex-late-repo-"));
  try {
    const repo = join(scratch, "repo");
    const target = join(repo, ".agents", "skills");
    const registered: string[][] = [];
    const refresh = await registerCodexRepositorySkills(
      [repo],
      async (paths) => {
        registered.push(paths);
      },
    );
    expect(registered).toEqual([[target]]);
    await refresh?.();
    await mkdir(repo);
    await refresh?.();
    expect(registered).toEqual([[target]]);
    await mkdir(target, { recursive: true });
    await refresh?.();
    await refresh?.();
    expect(registered).toEqual([[target], [target]]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
