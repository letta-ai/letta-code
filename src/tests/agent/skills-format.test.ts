import { describe, expect, test } from "bun:test";
import { formatSkillsForMemory, type Skill } from "../../agent/skills";

describe("Skills formatting", () => {
  test("shows full metadata for small skill collections", () => {
    const skills: Skill[] = [
      {
        id: "testing",
        name: "Testing",
        description: "Unit testing patterns and conventions",
        path: "/test/.skills/testing/SKILL.md",
      },
      {
        id: "deployment",
        name: "Deployment",
        description: "Deployment workflows and scripts",
        path: "/test/.skills/deployment/SKILL.md",
      },
    ];

    const result = formatSkillsForMemory(skills, "/test/.skills");

    // Should contain full metadata
    expect(result).toContain("Available Skills:");
    expect(result).toContain("### Testing");
    expect(result).toContain("ID: `testing`");
    expect(result).toContain("Description: Unit testing patterns");
    expect(result).toContain("### Deployment");
    
    // Should NOT contain tree format markers
    expect(result).not.toContain("Note: Many skills available");
  });

  test("shows tree format when full metadata exceeds limit", () => {
    // Create enough skills with long descriptions to exceed 20k chars
    const skills: Skill[] = [];
    const longDescription = "A".repeat(500); // 500 chars per description
    
    for (let i = 0; i < 50; i++) {
      skills.push({
        id: `category-${i}/skill-${i}`,
        name: `Skill ${i}`,
        description: longDescription,
        path: `/test/.skills/category-${i}/skill-${i}/SKILL.md`,
      });
    }

    const result = formatSkillsForMemory(skills, "/test/.skills");

    // Should contain tree format markers
    expect(result).toContain("Note: Many skills available");
    expect(result).toContain("showing directory structure only");
    
    // Should NOT contain full metadata markers
    expect(result).not.toContain("Available Skills:");
    expect(result).not.toContain("Description:");
    
    // Should show directory structure
    expect(result).toContain("category-");
    expect(result).toContain("skill-");
  });

  test("tree format shows nested directory structure", () => {
    const skills: Skill[] = [];
    const longDescription = "A".repeat(500);
    
    // Create nested skills to exceed limit
    for (let i = 0; i < 50; i++) {
      skills.push({
        id: `ai/tools/tool-${i}`,
        name: `Tool ${i}`,
        description: longDescription,
        path: `/test/.skills/ai/tools/tool-${i}/SKILL.md`,
      });
    }

    const result = formatSkillsForMemory(skills, "/test/.skills");

    // Should show hierarchical structure
    expect(result).toContain("ai/");
    expect(result).toContain("  tools/");
    expect(result).toContain("    tool-");
  });

  test("handles empty skill list", () => {
    const result = formatSkillsForMemory([], "/test/.skills");

    expect(result).toContain("Skills Directory: /test/.skills");
    expect(result).toContain("[NO SKILLS AVAILABLE]");
  });

  test("tree format includes helper message", () => {
    const skills: Skill[] = [];
    const longDescription = "A".repeat(500);
    
    for (let i = 0; i < 50; i++) {
      skills.push({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: longDescription,
        path: `/test/.skills/skill-${i}/SKILL.md`,
      });
    }

    const result = formatSkillsForMemory(skills, "/test/.skills");

    // Should include usage instructions
    expect(result).toContain("Load it persistently into memory");
    expect(result).toContain("Read");
    expect(result).toContain("SKILL.md");
    expect(result).toContain("preview without loading");
  });

  test("full format respects character limit boundary", () => {
    // Create skills that are just under the limit
    const skills: Skill[] = [];
    
    // Each skill formatted is roughly 100 chars, so ~190 skills should be under 20k
    for (let i = 0; i < 10; i++) {
      skills.push({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: "Short description",
        path: `/test/.skills/skill-${i}/SKILL.md`,
      });
    }

    const result = formatSkillsForMemory(skills, "/test/.skills");

    // With short descriptions, should still use full format
    expect(result).toContain("Available Skills:");
    expect(result.length).toBeLessThan(20000);
  });

  test("tree format groups skills by directory correctly", () => {
    const skills: Skill[] = [];
    const longDescription = "A".repeat(500);
    
    for (let i = 0; i < 30; i++) {
      skills.push({
        id: `ai/agents/agent-${i}`,
        name: `Agent ${i}`,
        description: longDescription,
        path: `/test/.skills/ai/agents/agent-${i}/SKILL.md`,
      });
    }
    
    for (let i = 0; i < 30; i++) {
      skills.push({
        id: `development/patterns/pattern-${i}`,
        name: `Pattern ${i}`,
        description: longDescription,
        path: `/test/.skills/development/patterns/pattern-${i}/SKILL.md`,
      });
    }

    const result = formatSkillsForMemory(skills, "/test/.skills");

    // Should show both top-level directories
    expect(result).toContain("ai/");
    expect(result).toContain("development/");
    
    // Should show nested structure
    expect(result).toContain("  agents/");
    expect(result).toContain("  patterns/");
  });
});
