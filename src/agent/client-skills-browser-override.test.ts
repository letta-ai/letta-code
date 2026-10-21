import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import {
  buildClientSkillsPayload,
  invalidateClientSkillsPayloadCache,
} from "@/agent/client-skills";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";

let restoreAmbientEnv: (() => void) | undefined;

beforeEach(() => {
  restoreAmbientEnv = isolateAmbientLettaTestEnv();
  invalidateClientSkillsPayloadCache();
});

afterEach(() => {
  invalidateClientSkillsPayloadCache();
  restoreAmbientEnv?.();
  restoreAmbientEnv = undefined;
});

test("lets a project skill override a bundled skill with the same name", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-skill-override-"));

  try {
    const projectSkillDir = join(tempRoot, ".agents", "skills", "browser-use");
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(
      join(projectSkillDir, "SKILL.md"),
      [
        "---",
        "name: browser-use",
        "description: Environment-specific browser controller",
        "---",
        "",
        "Use the environment browser controller.",
      ].join("\n"),
    );

    const result = await buildClientSkillsPayload({
      workingDirectory: tempRoot,
      skillsDirectory: join(tempRoot, ".skills"),
      skillSources: ["bundled", "project"],
      attachedRepositories: [],
    });

    expect(
      result.clientSkills.find((skill) => skill.name === "browser-use"),
    ).toEqual({
      name: "browser-use",
      description: "Environment-specific browser controller",
      location: join(projectSkillDir, "SKILL.md"),
    });
    expect(
      result.availableSkills.find((skill) => skill.id === "browser-use"),
    ).toEqual({
      id: "browser-use",
      name: "browser-use",
      description: "Environment-specific browser controller",
      path: join(projectSkillDir, "SKILL.md"),
      source: "project",
    });
    expect(result.skillPathById["browser-use"]).toBe(
      join(projectSkillDir, "SKILL.md"),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
