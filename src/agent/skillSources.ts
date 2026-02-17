import type { SkillSource } from "./skills";

export const ALL_SKILL_SOURCES: SkillSource[] = [
  "bundled",
  "global",
  "agent",
  "project",
];

export type SkillSourceSpecifier = SkillSource | "all";

export type SkillSourceSelectionInput = {
  skillSourcesRaw?: string;
  noSkills?: boolean;
  noBundledSkills?: boolean;
};

const VALID_SKILL_SOURCE_SPECIFIERS: SkillSourceSpecifier[] = [
  "all",
  ...ALL_SKILL_SOURCES,
];

function isSkillSource(value: string): value is SkillSource {
  return ALL_SKILL_SOURCES.includes(value as SkillSource);
}

function normalizeSkillSources(sources: SkillSource[]): SkillSource[] {
  const sourceSet = new Set(sources);
  return ALL_SKILL_SOURCES.filter((source) => sourceSet.has(source));
}

export function parseSkillSourcesList(skillSourcesRaw: string): SkillSource[] {
  const tokens = skillSourcesRaw
    .split(",")
    .map((source) => source.trim())
    .filter((source) => source.length > 0);

  if (tokens.length === 0) {
    throw new Error(
      "--skill-sources must include at least one source (e.g. bundled,project)",
    );
  }

  const sources: SkillSource[] = [];
  for (const token of tokens) {
    const source = token as SkillSourceSpecifier;
    if (!VALID_SKILL_SOURCE_SPECIFIERS.includes(source)) {
      throw new Error(
        `Invalid skill source "${token}". Valid values: ${VALID_SKILL_SOURCE_SPECIFIERS.join(", ")}`,
      );
    }

    if (source === "all") {
      sources.push(...ALL_SKILL_SOURCES);
      continue;
    }

    if (isSkillSource(source)) {
      sources.push(source);
    }
  }

  return normalizeSkillSources(sources);
}

export function resolveSkillSourcesSelection(
  input: SkillSourceSelectionInput,
): SkillSource[] {
  if (input.noSkills) {
    return [];
  }

  const configuredSources = input.skillSourcesRaw
    ? parseSkillSourcesList(input.skillSourcesRaw)
    : [...ALL_SKILL_SOURCES];

  const filteredSources = input.noBundledSkills
    ? configuredSources.filter((source) => source !== "bundled")
    : configuredSources;

  return normalizeSkillSources(filteredSources);
}
