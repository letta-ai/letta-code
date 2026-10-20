import { describe, expect, test } from "bun:test";
import type { Skill } from "@/agent/skills";
import {
  buildExternalCodingAgentSkillsReminder,
  resolveExternalCodingAgentSkillsReminder,
} from "./external-coding-agent-skills";

function skill(id: string, source: Skill["source"] = "project"): Skill {
  return {
    id,
    name: id,
    description: "Review database changes",
    source,
    path: `/repo/.agents/skills/${id}/SKILL.md`,
  };
}

describe("external coding agent skills", () => {
  test("excludes bundled and manual-only skills, and provides usable absolute paths", () => {
    const reminder = buildExternalCodingAgentSkillsReminder([
      skill("builtin", "bundled"),
      { ...skill("manual"), disableModelInvocation: true },
      skill("database-review"),
    ]);
    expect(reminder).toBe(`<system-reminder>
The following skills are available. Read the relevant SKILL.md before using a skill; resolve its referenced files relative to that file's directory.

- database-review: Review database changes
  SKILL.md: /repo/.agents/skills/database-review/SKILL.md
</system-reminder>`);
  });

  test("empty or bundled-only discovery adds nothing", () => {
    expect(buildExternalCodingAgentSkillsReminder([])).toBeUndefined();
    expect(
      buildExternalCodingAgentSkillsReminder([skill("builtin", "bundled")]),
    ).toBeUndefined();
  });

  test("discovers using the resolved parent scope and worker project directory", async () => {
    let discovered = false;
    const reminder = await resolveExternalCodingAgentSkillsReminder(
      "child",
      "/project",
      {
        getScopeAgentId: async (id) => {
          expect(id).toBe("child");
          return "parent";
        },
        discoverSkills: async (options) => {
          expect(options?.agentId).toBe("parent");
          expect(options?.workingDirectory).toBe("/project");
          expect(options?.skillSources).not.toContain("bundled");
          discovered = true;
          return { skills: [skill("parent-skill", "agent")], errors: [] };
        },
      },
    );
    expect(discovered).toBe(true);
    expect(reminder).toContain("parent-skill");
  });

  test("caps large inventories without cutting paths", () => {
    const reminder = buildExternalCodingAgentSkillsReminder(
      Array.from({ length: 200 }, (_, i) => skill(`skill-${i}`)),
    );
    expect(reminder?.match(/SKILL.md:/g)).toHaveLength(100);
    expect(reminder?.endsWith("/SKILL.md\n</system-reminder>")).toBe(true);
    expect(
      buildExternalCodingAgentSkillsReminder([
        { ...skill("huge"), description: "x".repeat(33_000) },
      ]),
    ).toBeUndefined();
  });
});
