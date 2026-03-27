import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseMdxFrontmatter } from "./memory";
import { getMemoryRepoDir, pullMemory, pushMemory } from "./memoryGit";
import { MEMORY_PROMPTS, SYSTEM_PROMPTS } from "./promptAssets";

const execFile = promisify(execFileCb);

const PRIMARY_PERSONA_RELATIVE_PATH = "system/persona.md";
const LEGACY_PERSONA_RELATIVE_PATH = "memory/system/persona.md";

export interface PersonalityOption {
  id: "kawaii" | "codex" | "claude" | "linus" | "memo";
  label: string;
  description: string;
}

export const PERSONALITY_OPTIONS: PersonalityOption[] = [
  {
    id: "memo",
    label: "Memo",
    description: "A thoughtful, substantive coding assistant that learns",
  },
  {
    id: "linus",
    label: "Linus",
    description: "Blunt and unfiltered, inspired by Linus Torvalds",
  },
  {
    id: "kawaii",
    label: "Kawaii",
    description: "A cute anime-inspired personality",
  },
  {
    id: "claude",
    label: "Claude",
    description: "A concise engineering personality from Claude Code",
  },
  {
    id: "codex",
    label: "Codex",
    description: "A pragmatic coding personality from Codex",
  },
];

export type PersonalityId = PersonalityOption["id"];

export interface ApplyPersonalityToMemoryParams {
  agentId: string;
  personalityId: PersonalityId;
  commitMessage?: string;
}

export interface ApplyPersonalityToMemoryResult {
  changed: boolean;
  personality: PersonalityOption;
  personaRelativePath: string;
  commitMessage?: string;
}

const FRONTMATTER_REGEX = /^(---\n[\s\S]*?\n---)\n*/;

function normalizeComparableContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function ensureTrailingNewline(content: string): string {
  return `${content.trimEnd()}\n`;
}

function buildDefaultPersonaFile(body: string): string {
  return `---\ndescription: Agent personality\nlimit: 20000\n---\n\n${ensureTrailingNewline(body.trim())}`;
}

function getPersonaRelativePathForRepo(repoDir: string): string {
  const primaryPath = join(repoDir, PRIMARY_PERSONA_RELATIVE_PATH);
  if (existsSync(primaryPath)) {
    return PRIMARY_PERSONA_RELATIVE_PATH;
  }

  const legacyPath = join(repoDir, LEGACY_PERSONA_RELATIVE_PATH);
  if (existsSync(legacyPath)) {
    return LEGACY_PERSONA_RELATIVE_PATH;
  }

  // Prefer legacy layout when the repo has a top-level memory/ directory.
  if (existsSync(join(repoDir, "memory"))) {
    return LEGACY_PERSONA_RELATIVE_PATH;
  }

  return PRIMARY_PERSONA_RELATIVE_PATH;
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

export function getPersonalityContent(personalityId: PersonalityId): string {
  if (personalityId === "memo") {
    const rawPrompt = MEMORY_PROMPTS["persona_memo.mdx"];
    if (!rawPrompt) {
      throw new Error("Missing built-in prompt content for persona_memo.mdx");
    }
    const { body } = parseMdxFrontmatter(rawPrompt);
    if (!body.trim()) {
      throw new Error("persona_memo.mdx has empty body content");
    }
    return ensureTrailingNewline(body);
  }

  if (personalityId === "kawaii") {
    const rawPrompt = MEMORY_PROMPTS["persona_kawaii.mdx"];
    if (!rawPrompt) {
      throw new Error("Missing built-in prompt content for persona_kawaii.mdx");
    }

    const { body } = parseMdxFrontmatter(rawPrompt);
    if (!body.trim()) {
      throw new Error("persona_kawaii.mdx has empty body content");
    }
    return ensureTrailingNewline(body);
  }

  if (personalityId === "codex") {
    return ensureTrailingNewline(getSystemPromptById("source-codex"));
  }

  if (personalityId === "linus") {
    const rawPrompt = MEMORY_PROMPTS["persona_linus.mdx"];
    if (!rawPrompt) {
      throw new Error("Missing built-in prompt content for persona_linus.mdx");
    }
    const { body } = parseMdxFrontmatter(rawPrompt);
    if (!body.trim()) {
      throw new Error("persona_linus.mdx has empty body content");
    }
    return ensureTrailingNewline(body);
  }

  return ensureTrailingNewline(getSystemPromptById("source-claude"));
}

export function replaceBodyPreservingFrontmatter(
  existingPersonaFile: string,
  newBody: string,
): string {
  const frontmatterMatch = existingPersonaFile.match(FRONTMATTER_REGEX);
  if (!frontmatterMatch || frontmatterMatch.index !== 0) {
    throw new Error(
      "system/persona.md is missing valid frontmatter; cannot safely replace personality body.",
    );
  }

  const frontmatter = frontmatterMatch[1];
  const normalizedBody = ensureTrailingNewline(newBody.trim());
  if (!normalizedBody.trim()) {
    throw new Error("Personality content cannot be empty");
  }

  return `${frontmatter}\n\n${normalizedBody}`;
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
  relativePath: string,
): Promise<boolean> {
  try {
    await runGit(cwd, ["diff", "--cached", "--quiet", "--", relativePath]);
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
  const personalityContent = getPersonalityContent(params.personalityId);

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
  const personaPath = join(repoDir, personaRelativePath);

  const existingPersona = existsSync(personaPath)
    ? readFileSync(personaPath, "utf-8")
    : null;
  const nextPersona = existingPersona
    ? replaceBodyPreservingFrontmatter(existingPersona, personalityContent)
    : buildDefaultPersonaFile(personalityContent);

  if (
    existingPersona !== null &&
    normalizeComparableContent(existingPersona) ===
      normalizeComparableContent(nextPersona)
  ) {
    return {
      changed: false,
      personality,
      personaRelativePath,
    };
  }

  mkdirSync(dirname(personaPath), { recursive: true });
  writeFileSync(personaPath, nextPersona, "utf-8");

  await runGit(repoDir, ["add", "--", personaRelativePath]);

  if (!(await hasStagedChanges(repoDir, personaRelativePath))) {
    return {
      changed: false,
      personality,
      personaRelativePath,
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
    personaRelativePath,
  ]);

  await pushMemory(params.agentId);

  return {
    changed: true,
    personality,
    personaRelativePath,
    commitMessage,
  };
}
