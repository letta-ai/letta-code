import { describe, expect, test } from "bun:test";
import {
  detectPersonalityFromPersonaFile,
  getDefaultHumanContent,
  getPersonalityBlockDefinitions,
  getPersonalityBlockValues,
  getPersonalityContent,
  getPersonalityHumanContent,
  PERSONALITY_OPTIONS,
  replaceBodyPreservingFrontmatter,
  resolvePersonalityId,
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

  test("resolvePersonalityId accepts public Letta Code alias", () => {
    expect(resolvePersonalityId("letta-code")).toBe("memo");
    expect(resolvePersonalityId("LettaCode")).toBe("memo");
    expect(resolvePersonalityId("memo")).toBe("memo");
  });

  test("personality block values always include both persona and human", () => {
    for (const option of PERSONALITY_OPTIONS) {
      const values = getPersonalityBlockValues(option.id);
      expect(values.persona.trim().length).toBeGreaterThan(0);
      expect(values.human.trim().length).toBeGreaterThan(0);
    }
  });

  test("claude and codex use the default human block", () => {
    const defaultHuman = getDefaultHumanContent();
    expect(getPersonalityHumanContent("claude")).toBe(defaultHuman);
    expect(getPersonalityHumanContent("codex")).toBe(defaultHuman);
  });

  test("kawaii block definitions carry personality-specific descriptions", () => {
    const definitions = getPersonalityBlockDefinitions("kawaii");
    expect(definitions.persona.description).toContain("sparkly memory");
    expect(definitions.human.description).toContain("senpai");
  });
});
