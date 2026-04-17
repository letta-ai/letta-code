import { describe, expect, test } from "bun:test";
import {
  buildCreateAgentOptionsForPersonality,
  DEFAULT_CREATE_AGENT_PERSONALITIES,
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

  test("resolvePersonalityId accepts caveman aliases", () => {
    expect(resolvePersonalityId("caveman")).toBe("caveman");
    expect(resolvePersonalityId("cave-code")).toBe("caveman");
  });

  test("personality block values always include both persona and human", () => {
    for (const option of PERSONALITY_OPTIONS) {
      const values = getPersonalityBlockValues(option.id);
      expect(values.persona.trim().length).toBeGreaterThan(0);
      expect(values.human.trim().length).toBeGreaterThan(0);
    }
  });

  test("claude, codex, and caveman use the default human block", () => {
    const defaultHuman = getDefaultHumanContent();
    expect(getPersonalityHumanContent("claude")).toBe(defaultHuman);
    expect(getPersonalityHumanContent("codex")).toBe(defaultHuman);
    expect(getPersonalityHumanContent("caveman")).toBe(defaultHuman);
  });

  test("default create-agent personalities are exactly memo, linus, and kawaii", () => {
    expect(DEFAULT_CREATE_AGENT_PERSONALITIES).toEqual([
      "memo",
      "linus",
      "kawaii",
    ]);
  });

  test("buildCreateAgentOptionsForPersonality maps the curated presets to personality-specific memory blocks", async () => {
    for (const personality of [...DEFAULT_CREATE_AGENT_PERSONALITIES]) {
      const definitions = getPersonalityBlockDefinitions(personality);
      const options = await buildCreateAgentOptionsForPersonality({
        personalityId: personality,
      });
      const personaBlock = options.memoryBlocks?.find(
        (block): block is { label: string; value: string } =>
          "label" in block && block.label === "persona",
      );
      const humanBlock = options.memoryBlocks?.find(
        (block): block is { label: string; value: string } =>
          "label" in block && block.label === "human",
      );

      expect(options).toMatchObject({
        name: PERSONALITY_OPTIONS.find((option) => option.id === personality)
          ?.label,
        description: PERSONALITY_OPTIONS.find(
          (option) => option.id === personality,
        )?.description,
        memoryPromptMode: "memfs",
      });
      expect(personaBlock?.value).toBe(definitions.persona.value);
      expect(humanBlock?.value).toBe(definitions.human.value);
    }
  });

  test("buildCreateAgentOptionsForPersonality preserves caller-provided tags", async () => {
    const options = await buildCreateAgentOptionsForPersonality({
      personalityId: "memo",
      tags: ["desktop", "favorite"],
    });

    expect(options.tags).toEqual(["desktop", "favorite"]);
  });

  test("kawaii block definitions carry personality-specific descriptions", () => {
    const definitions = getPersonalityBlockDefinitions("kawaii");
    expect(definitions.persona.description).toContain("sparkly memory");
    expect(definitions.human.description).toContain("senpai");
  });

  test("caveman block definitions use the caveman persona template", () => {
    const definitions = getPersonalityBlockDefinitions("caveman");
    expect(definitions.persona.templatePromptAssetName).toBe(
      "persona_caveman.mdx",
    );
    expect(
      PERSONALITY_OPTIONS.find((option) => option.id === "caveman"),
    ).toMatchObject({ defaultModel: "auto-chat", label: "cave-code" });
    expect(definitions.persona.value).toContain(
      "Think and speak like smart caveman",
    );
    expect(definitions.persona.value).toContain(
      "Every `reasoning_message` must show a cave-grunt",
    );
  });
});
