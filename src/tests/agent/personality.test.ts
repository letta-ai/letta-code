import { describe, expect, test } from "bun:test";
import {
  detectPersonalityFromPersonaFile,
  getPersonalityContent,
  PERSONALITY_OPTIONS,
  replaceBodyPreservingFrontmatter,
} from "../../agent/personality";

const VALID_FRONTMATTER = "---\ndescription: Persona\nlimit: 20000\n---\n\n";

describe("personality helpers", () => {
  test("replaceBodyPreservingFrontmatter swaps body and keeps frontmatter", () => {
    const existing = `${VALID_FRONTMATTER}old persona content\n`;
    const updated = replaceBodyPreservingFrontmatter(existing, "new body");

    expect(updated.startsWith(VALID_FRONTMATTER)).toBe(true);
    expect(updated).toContain("new body\n");
    expect(updated).not.toContain("old persona content");
  });

  test("replaceBodyPreservingFrontmatter rejects missing frontmatter", () => {
    expect(() =>
      replaceBodyPreservingFrontmatter("no frontmatter", "new body"),
    ).toThrowError();
  });

  test("detectPersonalityFromPersonaFile resolves built-in personalities", () => {
    for (const option of PERSONALITY_OPTIONS) {
      const personaFile = `${VALID_FRONTMATTER}${getPersonalityContent(option.id)}`;
      expect(detectPersonalityFromPersonaFile(personaFile)).toBe(option.id);
    }
  });

  test("detectPersonalityFromPersonaFile returns null for unknown body", () => {
    const personaFile = `${VALID_FRONTMATTER}This does not match any preset.\n`;
    expect(detectPersonalityFromPersonaFile(personaFile)).toBeNull();
  });
});
