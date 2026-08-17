import { describe, expect, it } from "bun:test";
import {
  findCatalogSkillPath,
  resolveGitCatalogLocation,
} from "@/agent/skill-catalog";

describe("skill catalog", () => {
  it("maps Hermes and skills.sh picker references to their repositories", () => {
    expect(
      resolveGitCatalogLocation({
        source: "official",
        name: "hyperframes",
      }),
    ).toEqual({
      repoUrl: "https://github.com/NousResearch/hermes-agent.git",
      searchName: "hyperframes",
      searchRoot: "optional-skills",
    });
    expect(
      resolveGitCatalogLocation({
        source: "skills.sh",
        name: "100m-leads",
        identifier: "skills-sh/getagentseal/founder-playbook/100m-leads",
      }),
    ).toEqual({
      repoUrl: "https://github.com/getagentseal/founder-playbook.git",
      requestedPath: "100m-leads",
      searchName: "100m-leads",
    });
  });

  it("uses exact catalog paths before same-named copies elsewhere", () => {
    expect(
      findCatalogSkillPath(
        [
          ".agents/skills/review/SKILL.md",
          "skills/review/SKILL.md",
          "packages/review/SKILL.md",
        ],
        {
          repoUrl: "https://github.com/acme/skills.git",
          requestedPath: "packages/review",
          searchName: "review",
        },
      ),
    ).toBe("packages/review");
  });

  it("does not substitute a same-named skill when the catalog path is missing", () => {
    expect(() =>
      findCatalogSkillPath(["skills/review/SKILL.md"], {
        repoUrl: "https://github.com/acme/skills.git",
        requestedPath: "packages/review",
        searchName: "review",
      }),
    ).toThrow("Could not find SKILL.md for review.");
  });

  it("keeps built-in lookup inside the Hermes built-in directory", () => {
    expect(
      findCatalogSkillPath(
        [
          "optional-skills/apple/apple-notes/SKILL.md",
          "skills/apple/apple-notes/SKILL.md",
        ],
        {
          repoUrl: "https://github.com/NousResearch/hermes-agent.git",
          searchName: "apple-notes",
          searchRoot: "skills",
        },
      ),
    ).toBe("skills/apple/apple-notes");
  });

  it("recognizes the live browse-sh source name", () => {
    expect(
      resolveGitCatalogLocation({
        source: "browse-sh",
        name: "account-management",
        identifier: "browse-sh/plugandpay.com/account-management-ic4kjh",
      }),
    ).toBeNull();
  });

  it("rejects catalog identifiers that are not GitHub repository paths", () => {
    expect(
      resolveGitCatalogLocation({
        source: "github",
        name: "unsafe",
        identifier: "owner/repo/../unsafe",
      }),
    ).toBeNull();
  });
});
