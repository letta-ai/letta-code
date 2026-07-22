/**
 * Pure personality preset definitions and content builders.
 *
 * This module must stay free of Node/backend imports: it is bundled into the
 * browser-safe `@letta-ai/letta-code/agent-presets` package export so that
 * other surfaces (e.g. the chat web app) can build byte-identical agent
 * creation payloads. Filesystem application of personalities lives in
 * `personality.ts`.
 */

import { parseMdxFrontmatter } from "./memory";
import { MEMORY_PROMPTS, SYSTEM_PROMPTS } from "./prompt-assets";

export interface PersonalityOption {
  id: "blank" | "kawaii" | "codex" | "claude" | "linus" | "memo" | "tutorial";
  label: string;
  description: string;
  /** Model ID from models.json to use when no explicit model is provided. */
  defaultModel?: string;
}

export const PERSONALITY_OPTIONS: PersonalityOption[] = [
  {
    id: "memo",
    label: "Letta Code",
    description: "The memory-first agent",
  },
  {
    id: "tutorial",
    label: "Tutor",
    description:
      "I help with getting started with Letta. I can answer any questions about Letta, and also help you create and configure agents.",
  },
  {
    id: "blank",
    label: "Blank",
    description: "Blank starter — you provide the personality",
  },
  {
    id: "linus",
    label: "Linus",
    description: "Code with a stern hand",
  },
  {
    id: "kawaii",
    label: "Letta-Chan",
    description: "sugoi~ (◕‿◕)✨",
    defaultModel: "auto-chat",
  },
  {
    id: "claude",
    label: "Letta Code",
    description: "Vanilla Claude flavors",
  },
  {
    id: "codex",
    label: "Letta Code",
    description: "Vanilla Codex flavors",
  },
];

export type PersonalityId = PersonalityOption["id"];
export type PersonalityEnvironment = "cloud" | "local";

export const DEFAULT_CREATE_AGENT_PERSONALITIES = [
  "memo",
  "tutorial",
  "blank",
  "linus",
  "kawaii",
] as const;

export type DefaultCreateAgentPersonalityId =
  (typeof DEFAULT_CREATE_AGENT_PERSONALITIES)[number];

const PERSONALITY_ALIASES: Record<string, PersonalityId> = {
  "letta-code": "memo",
  lettacode: "memo",
  memo: "memo",
};

export interface PersonalityBlockDefinition {
  value: string;
  description?: string;
  templatePromptAssetName: string;
}

export const ONBOARDING_PERSONALITIES = [
  "tutorial",
] as const satisfies readonly PersonalityId[];

export function supportsOnboardingBlock(
  personalityId: PersonalityId,
): personalityId is (typeof ONBOARDING_PERSONALITIES)[number] {
  return (ONBOARDING_PERSONALITIES as readonly PersonalityId[]).includes(
    personalityId,
  );
}

export const FRONTMATTER_REGEX = /^(---\n[\s\S]*?\n---)\n*/;
const EDITABLE_FRONTMATTER_KEYS = [
  "description",
  "limit",
  "read_only",
] as const;

export function normalizeComparableContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function ensureTrailingNewline(content: string): string {
  return `${content.trimEnd()}\n`;
}

function getPromptTemplate(promptAssetName: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const rawPrompt = MEMORY_PROMPTS[promptAssetName];
  if (!rawPrompt) {
    throw new Error(`Missing built-in prompt content for ${promptAssetName}`);
  }

  return parseMdxFrontmatter(rawPrompt);
}

function getPromptBody(promptAssetName: string): string {
  const { body } = getPromptTemplate(promptAssetName);
  if (!body.trim()) {
    throw new Error(`${promptAssetName} has empty body content`);
  }

  return ensureTrailingNewline(body);
}

function getEditablePromptFrontmatter(
  promptAssetName: string,
): Record<string, string> {
  const { frontmatter } = getPromptTemplate(promptAssetName);
  return Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) =>
      (EDITABLE_FRONTMATTER_KEYS as readonly string[]).includes(key),
    ),
  );
}

export function serializeFrontmatter(
  frontmatter: Record<string, string>,
): string {
  const orderedKeys = [
    ...EDITABLE_FRONTMATTER_KEYS,
    ...Object.keys(frontmatter).filter(
      (key) => !(EDITABLE_FRONTMATTER_KEYS as readonly string[]).includes(key),
    ),
  ];
  const lines: string[] = [];

  for (const key of orderedKeys) {
    const value = frontmatter[key];
    if (value === undefined) {
      continue;
    }
    lines.push(`${key}: ${value}`);
  }

  return `---\n${lines.join("\n")}\n---`;
}

export function buildDefaultMemoryFile(
  templatePromptAssetName: string,
  body: string,
  description?: string,
): string {
  const normalizedBody = ensureTrailingNewline(body.trim());
  if (!normalizedBody.trim()) {
    throw new Error("Memory content cannot be empty");
  }

  const frontmatter = getEditablePromptFrontmatter(templatePromptAssetName);
  if (description !== undefined) {
    frontmatter.description = description;
  }

  if (Object.keys(frontmatter).length === 0) {
    return normalizedBody;
  }

  return `${serializeFrontmatter(frontmatter)}\n\n${normalizedBody}`;
}

function getSystemPromptById(systemPromptId: string): string {
  const prompt = SYSTEM_PROMPTS.find(
    (candidate) => candidate.id === systemPromptId,
  );
  if (!prompt || !prompt.content.trim()) {
    throw new Error(`Missing built-in prompt content for ${systemPromptId}`);
  }
  return prompt.content;
}

export function getPersonalityOption(
  personalityId: PersonalityId,
): PersonalityOption {
  const option = PERSONALITY_OPTIONS.find(
    (candidate) => candidate.id === personalityId,
  );
  if (!option) {
    throw new Error(`Unknown personality: ${personalityId}`);
  }
  return option;
}

export function resolvePersonalityId(input: string): PersonalityId | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const direct = PERSONALITY_OPTIONS.find(
    (candidate) => candidate.id === normalized,
  );
  if (direct) {
    return direct.id;
  }

  return PERSONALITY_ALIASES[normalized] ?? null;
}

export function getPersonalityContent(personalityId: PersonalityId): string {
  if (personalityId === "memo") {
    return getPromptBody("persona_memo.mdx");
  }

  if (personalityId === "tutorial") {
    return getPromptBody("persona_tutorial.mdx");
  }

  if (personalityId === "blank") {
    return getPromptBody("persona_blank.mdx");
  }

  if (personalityId === "kawaii") {
    return getPromptBody("persona_kawaii.mdx");
  }

  if (personalityId === "codex") {
    return ensureTrailingNewline(getSystemPromptById("source-codex"));
  }

  if (personalityId === "linus") {
    return getPromptBody("persona_linus.mdx");
  }

  return ensureTrailingNewline(getSystemPromptById("source-claude"));
}

export function getDefaultHumanContent(): string {
  return getPromptBody("human.mdx");
}

export function getPersonalityHumanContent(
  personalityId: PersonalityId,
): string {
  if (personalityId === "memo") {
    return getPromptBody("human_memo.mdx");
  }

  if (personalityId === "tutorial") {
    return getPromptBody("human_tutorial.mdx");
  }

  if (personalityId === "linus") {
    return getPromptBody("human_linus.mdx");
  }

  if (personalityId === "kawaii") {
    return getPromptBody("human_kawaii.mdx");
  }

  if (personalityId === "blank") {
    return getDefaultHumanContent();
  }

  return getDefaultHumanContent();
}

export function getPersonalityBlockValues(personalityId: PersonalityId): {
  persona: string;
  human: string;
} {
  const overrides = getPersonalityBlockDefinitions(personalityId);
  return {
    persona: overrides.persona.value,
    human: overrides.human.value,
  };
}

export function getPersonalityBlockDefinitions(
  personalityId: PersonalityId,
  environment: PersonalityEnvironment = "cloud",
): {
  persona: PersonalityBlockDefinition;
  human: PersonalityBlockDefinition;
  onboarding?: PersonalityBlockDefinition;
} {
  const personaTemplatePromptAssetName =
    personalityId === "memo"
      ? "persona_memo.mdx"
      : personalityId === "tutorial"
        ? "persona_tutorial.mdx"
        : personalityId === "blank"
          ? "persona_blank.mdx"
          : personalityId === "kawaii"
            ? "persona_kawaii.mdx"
            : personalityId === "linus"
              ? "persona_linus.mdx"
              : "persona.mdx";
  const humanTemplatePromptAssetName =
    personalityId === "memo"
      ? "human_memo.mdx"
      : personalityId === "tutorial"
        ? "human_tutorial.mdx"
        : personalityId === "kawaii"
          ? "human_kawaii.mdx"
          : personalityId === "linus"
            ? "human_linus.mdx"
            : "human.mdx";
  const onboardingTemplatePromptAssetName =
    environment === "local" ? "onboarding_local.mdx" : "onboarding.mdx";

  return {
    persona: {
      value: getPersonalityContent(personalityId),
      description: getEditablePromptFrontmatter(personaTemplatePromptAssetName)
        .description,
      templatePromptAssetName: personaTemplatePromptAssetName,
    },
    human: {
      value: getPersonalityHumanContent(personalityId),
      description: getEditablePromptFrontmatter(humanTemplatePromptAssetName)
        .description,
      templatePromptAssetName: humanTemplatePromptAssetName,
    },
    ...(supportsOnboardingBlock(personalityId)
      ? {
          onboarding: {
            value: getPromptBody(onboardingTemplatePromptAssetName),
            description: getEditablePromptFrontmatter(
              onboardingTemplatePromptAssetName,
            ).description,
            templatePromptAssetName: onboardingTemplatePromptAssetName,
          },
        }
      : {}),
  };
}

export interface PersonalityMemoryBlock {
  label: string;
  value: string;
  description?: string;
}

/**
 * Build the memory blocks a new agent gets for a personality: the default
 * blocks with persona/human values replaced by the personality's content,
 * plus the onboarding block for personalities that support it.
 *
 * Shared by the CLI create path (`buildCreateAgentOptionsForPersonality`) and
 * the exported wire payload builder (`buildCreateAgentRequestForPersonality`).
 */
export function buildPersonalityMemoryBlocks(
  personalityId: PersonalityId,
  defaultMemoryBlocks: Array<{
    label: string;
    value: string;
    description?: string | null;
  }>,
  environment: PersonalityEnvironment = "cloud",
): PersonalityMemoryBlock[] {
  const blockDefinitions = getPersonalityBlockDefinitions(
    personalityId,
    environment,
  );

  const memoryBlocks = defaultMemoryBlocks.map((block) => {
    if (block.label === "persona") {
      return {
        label: block.label,
        value: blockDefinitions.persona.value,
        description:
          blockDefinitions.persona.description ??
          block.description ??
          undefined,
      };
    }

    if (block.label === "human") {
      return {
        label: block.label,
        value: blockDefinitions.human.value,
        description:
          blockDefinitions.human.description ?? block.description ?? undefined,
      };
    }

    return {
      label: block.label,
      value: block.value,
      description: block.description ?? undefined,
    };
  });

  if (blockDefinitions.onboarding) {
    memoryBlocks.push({
      label: "onboarding",
      value: blockDefinitions.onboarding.value,
      description: blockDefinitions.onboarding.description,
    });
  }

  return memoryBlocks;
}
