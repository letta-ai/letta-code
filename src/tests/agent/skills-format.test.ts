import { describe, expect, test } from "bun:test";
import { formatSkillsAsSystemReminder, type Skill } from "../../agent/skills";

describe("Skills formatting (system reminder)", () => {
  test("formats skills as system-reminder with id, source, and description", () => {
    const skills: Skill[] = [
      {
        id: "testing",
        name: "Testing",
        description: "Unit testing patterns and conventions",
        path: "/test/.skills/testing/SKILL.md",
        source: "project",
      },
      {
        id: "deployment",
        name: "Deployment",
        description: "Deployment workflows and scripts",
        path: "/test/.skills/deployment/SKILL.md",
        source: "project",
      },
    ];

    const result = formatSkillsAsSystemReminder(skills);

    expect(result).toContain("<system-reminder>");
    expect(result).toContain("</system-reminder>");
    expect(result).toContain("- testing (project): Unit testing patterns");
    expect(result).toContain(
      "- deployment (project): Deployment workflows and scripts",
    );
  });

  test("returns empty string for no skills", () => {
    const result = formatSkillsAsSystemReminder([]);
    expect(result).toBe("");
  });

  test("includes skills from multiple sources", () => {
    const skills: Skill[] = [
      {
        id: "bundled-skill",
        name: "Bundled Skill",
        description: "A built-in skill",
        path: "/bundled/SKILL.md",
        source: "bundled",
      },
      {
        id: "project-skill",
        name: "Project Skill",
        description: "A project-local skill",
        path: "/project/.skills/SKILL.md",
        source: "project",
      },
      {
        id: "global-skill",
        name: "Global Skill",
        description: "A global skill",
        path: "/global/.skills/SKILL.md",
        source: "global",
      },
    ];

    const result = formatSkillsAsSystemReminder(skills);

    expect(result).toContain("bundled-skill (bundled)");
    expect(result).toContain("project-skill (project)");
    expect(result).toContain("global-skill (global)");
  });
});
