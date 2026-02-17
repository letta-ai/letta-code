import { describe, expect, test } from "bun:test";
import {
  ALL_SKILL_SOURCES,
  parseSkillSourcesList,
  resolveSkillSourcesSelection,
} from "../../agent/skillSources";

describe("skill source selection", () => {
  test("defaults to all sources", () => {
    expect(resolveSkillSourcesSelection({})).toEqual(ALL_SKILL_SOURCES);
  });

  test("--no-skills disables all sources", () => {
    expect(
      resolveSkillSourcesSelection({
        noSkills: true,
      }),
    ).toEqual([]);
  });

  test("--no-bundled-skills removes bundled from default set", () => {
    expect(
      resolveSkillSourcesSelection({
        noBundledSkills: true,
      }),
    ).toEqual(["global", "agent", "project"]);
  });

  test("--skill-sources accepts explicit subsets and normalizes order", () => {
    expect(parseSkillSourcesList("project,global")).toEqual([
      "global",
      "project",
    ]);
  });

  test("--skill-sources supports all keyword", () => {
    expect(parseSkillSourcesList("all,project")).toEqual(ALL_SKILL_SOURCES);
  });

  test("throws for invalid source", () => {
    expect(() => parseSkillSourcesList("project,unknown")).toThrow(
      'Invalid skill source "unknown"',
    );
  });

  test("throws for empty --skill-sources value", () => {
    expect(() => parseSkillSourcesList(" , ")).toThrow(
      "--skill-sources must include at least one source",
    );
  });
});
