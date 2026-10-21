import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPreloadedSkills } from "@/agent/preloaded-skills";

test("headless preloads resolve selected skills from the configured filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-preload-"));
  try {
    for (const source of ["first", "second"]) {
      for (const name of ["selected", "unrequested"]) {
        const dir = join(root, source, name);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: Fixture skill\n---\n${name} instructions from ${source}\n`,
        );
      }
    }
    for (const source of ["first", "second"]) {
      const options = {
        workingDirectory: root,
        skillsDirectory: join(root, source),
        skillSources: ["project" as const],
        attachedRepositories: [],
      };
      const loaded = await loadPreloadedSkills(["selected"], options);
      expect(loaded).toContain(`selected instructions from ${source}`);
      expect(loaded).not.toContain(
        `from ${source === "first" ? "second" : "first"}`,
      );
      expect(loaded).not.toContain("unrequested instructions");
      expect(await loadPreloadedSkills(["missing"], options)).toBe("");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
