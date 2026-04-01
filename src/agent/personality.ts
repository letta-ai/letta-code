import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { settingsManager } from "../settings-manager";
import type { CreateAgentOptions } from "./create";
import { getDefaultMemoryBlocks, parseMdxFrontmatter } from "./memory";
import {
  GIT_MEMORY_ENABLED_TAG,
  getMemoryRepoDir,
  pullMemory,
  pushMemory,
} from "./memoryGit";
import { MEMORY_PROMPTS, SYSTEM_PROMPTS } from "./promptAssets";

const execFile = promisify(execFileCb);

const PRIMARY_PERSONA_RELATIVE_PATH = "system/persona.md";
const LEGACY_PERSONA_RELATIVE_PATH = "memory/system/persona.md";
const PRIMARY_HUMAN_RELATIVE_PATH = "system/human.md";
const LEGACY_HUMAN_RELATIVE_PATH = "memory/system/human.md";

export interface PersonalityOption {
  id: "kawaii" | "codex" | "claude" | "linus" | "memo";
  label: string;
  description: string;
}

export const PERSONALITY_OPTIONS: PersonalityOption[] = [
  {
    id: "memo",
    label: "Letta Code",
    description: "The memory-first agent",
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

export const DEFAULT_CREATE_AGENT_PERSONALITIES = [
  "memo",
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

export interface ApplyPersonalityToMemoryParams {
  agentId: string;
  personalityId: PersonalityId;
  commitMessage?: string;
}

export interface ApplyPersonalityToMemoryResult {
  changed: boolean;
  personality: PersonalityOption;
  personaRelativePath: string;
  humanRelativePath: string;
  commitMessage?: string;
}

export interface PersonalityBlockDefinition {
  value: string;
  description?: string;
  templatePromptAssetName: string;
}

const FRONTMATTER_REGEX = /^(---\n[\s\S]*?\n---)\n*/;
const EDITABLE_FRONTMATTER_KEYS = [
  "description",
  "limit",
  "read_only",
] as const;

function normalizeComparableContent(content: string): string {
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

function serializeFrontmatter(frontmatter: Record<string, string>): string {
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

function buildDefaultMemoryFile(
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

function getMemoryFileRelativePathForRepo(
  repoDir: string,
  primaryRelativePath: string,
  legacyRelativePath: string,
): string {
  const primaryPath = join(repoDir, primaryRelativePath);
  if (existsSync(primaryPath)) {
    return primaryRelativePath;
  }

  const legacyPath = join(repoDir, legacyRelativePath);
  if (existsSync(legacyPath)) {
    return legacyRelativePath;
  }

  // Prefer legacy layout when the repo has a top-level memory/ directory.
  if (existsSync(join(repoDir, "memory"))) {
    return legacyRelativePath;
  }

  return primaryRelativePath;
}

function getPersonaRelativePathForRepo(repoDir: string): string {
  return getMemoryFileRelativePathForRepo(
    repoDir,
    PRIMARY_PERSONA_RELATIVE_PATH,
    LEGACY_PERSONA_RELATIVE_PATH,
  );
}

function getHumanRelativePathForRepo(repoDir: string): string {
  return getMemoryFileRelativePathForRepo(
    repoDir,
    PRIMARY_HUMAN_RELATIVE_PATH,
    LEGACY_HUMAN_RELATIVE_PATH,
  );
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

  if (personalityId === "linus") {
    return getPromptBody("human_linus.mdx");
  }

  if (personalityId === "kawaii") {
    return getPromptBody("human_kawaii.mdx");
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

export function getPersonalityBlockDefinitions(personalityId: PersonalityId): {
  persona: PersonalityBlockDefinition;
  human: PersonalityBlockDefinition;
} {
  const personaTemplatePromptAssetName =
    personalityId === "memo"
      ? "persona_memo.mdx"
      : personalityId === "kawaii"
        ? "persona_kawaii.mdx"
        : personalityId === "linus"
          ? "persona_linus.mdx"
          : "persona.mdx";
  const humanTemplatePromptAssetName =
    personalityId === "memo"
      ? "human_memo.mdx"
      : personalityId === "kawaii"
        ? "human_kawaii.mdx"
        : personalityId === "linus"
          ? "human_linus.mdx"
          : "human.mdx";

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
  };
}

export async function buildCreateAgentOptionsForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  tags?: string[];
}): Promise<CreateAgentOptions> {
  const { personalityId, name, description, model, tags } = params;
  const personality = getPersonalityOption(personalityId);
  const blockDefinitions = getPersonalityBlockDefinitions(personalityId);
  const defaultMemoryBlocks = await getDefaultMemoryBlocks();

  return {
    name: name ?? personality.label,
    description: description ?? personality.description,
    model,
    tags,
    memoryPromptMode: "memfs",
    memoryBlocks: defaultMemoryBlocks.map((block) => {
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
            blockDefinitions.human.description ??
            block.description ??
            undefined,
        };
      }

      return {
        label: block.label,
        value: block.value,
        description: block.description ?? undefined,
      };
    }),
  };
}

export async function enableMemfsForCreatedAgent(params: {
  agentId: string;
  agentTags?: string[] | null;
}): Promise<void> {
  const { agentId, agentTags } = params;

  try {
    const { getClient } = await import("./client");
    const client = await getClient();
    const tags = agentTags || [];
    if (!tags.includes(GIT_MEMORY_ENABLED_TAG)) {
      await client.agents.update(agentId, {
        tags: [...tags, GIT_MEMORY_ENABLED_TAG],
      });
    }
    settingsManager.setMemfsEnabled(agentId, true);
  } catch {
    // Self-hosted or memfs not available - skip silently
  }
}

export async function createAgentForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  tags?: string[];
}): Promise<Awaited<ReturnType<typeof import("./create")["createAgent"]>>> {
  const { createAgent } = await import("./create");
  const result = await createAgent(
    await buildCreateAgentOptionsForPersonality(params),
  );

  await enableMemfsForCreatedAgent({
    agentId: result.agent.id,
    agentTags: result.agent.tags,
  });

  return result;
}

export function replaceBodyPreservingFrontmatter(
  existingPersonaFile: string,
  newBody: string,
  options?: { description?: string },
): string {
  const frontmatterMatch = existingPersonaFile.match(FRONTMATTER_REGEX);
  if (!frontmatterMatch || frontmatterMatch.index !== 0) {
    throw new Error(
      "Memory file is missing valid frontmatter; cannot safely replace its body.",
    );
  }

  const normalizedBody = ensureTrailingNewline(newBody.trim());
  if (!normalizedBody.trim()) {
    throw new Error("Personality content cannot be empty");
  }

  const { frontmatter } = parseMdxFrontmatter(existingPersonaFile);
  const mergedFrontmatter = { ...frontmatter };
  if (options?.description !== undefined) {
    mergedFrontmatter.description = options.description;
  }

  return `${serializeFrontmatter(mergedFrontmatter)}\n\n${normalizedBody}`;
}

export function detectPersonalityFromPersonaFile(
  personaFileContent: string,
): PersonalityId | null {
  const currentBody = normalizeComparableContent(
    personaFileContent.replace(FRONTMATTER_REGEX, ""),
  );

  for (const option of PERSONALITY_OPTIONS) {
    const expected = normalizeComparableContent(
      getPersonalityContent(option.id),
    );
    if (currentBody === expected) {
      return option.id;
    }
  }

  return null;
}

function isExitCode(error: unknown, expectedCode: number): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === expectedCode;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return result.stdout?.toString() ?? "";
}

async function hasStagedChanges(
  cwd: string,
  relativePaths: string[],
): Promise<boolean> {
  if (relativePaths.length === 0) {
    return false;
  }

  try {
    await runGit(cwd, ["diff", "--cached", "--quiet", "--", ...relativePaths]);
    return false;
  } catch (error) {
    if (isExitCode(error, 1)) {
      return true;
    }
    throw error;
  }
}

export async function applyPersonalityToMemory(
  params: ApplyPersonalityToMemoryParams,
): Promise<ApplyPersonalityToMemoryResult> {
  const personality = getPersonalityOption(params.personalityId);
  const blockDefinitions = getPersonalityBlockDefinitions(params.personalityId);

  const repoDir = getMemoryRepoDir(params.agentId);

  // Fail early if the memory repo has uncommitted changes
  const statusResult = await execFile("git", ["status", "--porcelain"], {
    cwd: repoDir,
    timeout: 10_000,
  });
  if (statusResult.stdout?.toString().trim()) {
    throw new Error(
      "Memory repo has uncommitted changes. Commit or discard them before switching personality.",
    );
  }

  await pullMemory(params.agentId);

  const personaRelativePath = getPersonaRelativePathForRepo(repoDir);
  const humanRelativePath = getHumanRelativePathForRepo(repoDir);
  const personaPath = join(repoDir, personaRelativePath);
  const humanPath = join(repoDir, humanRelativePath);

  const filesToUpdate = [
    {
      relativePath: personaRelativePath,
      absolutePath: personaPath,
      templatePromptAssetName: blockDefinitions.persona.templatePromptAssetName,
      content: blockDefinitions.persona.value,
      description: blockDefinitions.persona.description,
    },
    {
      relativePath: humanRelativePath,
      absolutePath: humanPath,
      templatePromptAssetName: blockDefinitions.human.templatePromptAssetName,
      content: blockDefinitions.human.value,
      description: blockDefinitions.human.description,
    },
  ];

  const changedPaths: string[] = [];

  for (const file of filesToUpdate) {
    const existingContent = existsSync(file.absolutePath)
      ? readFileSync(file.absolutePath, "utf-8")
      : null;
    const nextContent = existingContent
      ? replaceBodyPreservingFrontmatter(existingContent, file.content, {
          description: file.description,
        })
      : buildDefaultMemoryFile(
          file.templatePromptAssetName,
          file.content,
          file.description,
        );

    if (
      existingContent !== null &&
      normalizeComparableContent(existingContent) ===
        normalizeComparableContent(nextContent)
    ) {
      continue;
    }

    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, nextContent, "utf-8");
    changedPaths.push(file.relativePath);
  }

  if (changedPaths.length === 0) {
    return {
      changed: false,
      personality,
      personaRelativePath,
      humanRelativePath,
    };
  }

  await runGit(repoDir, ["add", "--", ...changedPaths]);

  if (!(await hasStagedChanges(repoDir, changedPaths))) {
    return {
      changed: false,
      personality,
      personaRelativePath,
      humanRelativePath,
    };
  }

  const commitMessage =
    params.commitMessage ??
    `chore(personality): switch to ${personality.label}`;

  await runGit(repoDir, [
    "commit",
    "--only",
    "-m",
    commitMessage,
    "--",
    ...changedPaths,
  ]);

  await pushMemory(params.agentId);

  return {
    changed: true,
    personality,
    personaRelativePath,
    humanRelativePath,
    commitMessage,
  };
}
