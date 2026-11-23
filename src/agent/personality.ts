import { execFile as execFileCb } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
} from "@/agent/agent-tags";
import { getBackend } from "@/backend";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { memoryNameFromPath } from "@/backend/local/initial-memory";
import { settingsManager } from "@/settings-manager";
import type { CreateAgentOptions } from "./create";
import { getDefaultMemoryBlocks, parseMdxFrontmatter } from "./memory";
import {
  getScopedMemoryFilesystemRoot,
  isLettaCloud,
} from "./memory-filesystem";
import { commitMemoryWrite, getMemoryRepoDir, pullMemory } from "./memory-git";
import { hasRootMemoryMarker } from "./memory-git-hooks";
import {
  buildDefaultMemoryFile,
  buildPersonalityMemoryBlocks,
  FRONTMATTER_REGEX,
  getPersonalityBlockDefinitions,
  getPersonalityContent,
  getPersonalityCreationTags,
  getPersonalityDefaultMemoryFiles,
  getPersonalityOption,
  normalizeComparableContent,
  PERSONALITY_OPTIONS,
  type PersonalityEnvironment,
  type PersonalityId,
  type PersonalityOption,
  serializeFrontmatter,
} from "./personality-presets";

const execFile = promisify(execFileCb);

const PRIMARY_PERSONA_RELATIVE_PATH = "system/persona.md";
const LEGACY_PERSONA_RELATIVE_PATH = "memory/system/persona.md";
const PRIMARY_HUMAN_RELATIVE_PATH = "system/human.md";
const LEGACY_HUMAN_RELATIVE_PATH = "memory/system/human.md";
const ROOT_PERSONA_RELATIVE_PATH = "persona.md";
const ROOT_HUMAN_RELATIVE_PATH = "human.md";

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

function ensureTrailingNewline(content: string): string {
  return `${content.trimEnd()}\n`;
}

function getMemoryFileRelativePathForRepo(
  repoDir: string,
  rootRelativePath: string,
  primaryRelativePath: string,
  legacyRelativePath: string,
): string {
  if (
    existsSync(join(repoDir, rootRelativePath)) ||
    hasRootMemoryMarker(repoDir)
  ) {
    return rootRelativePath;
  }

  const primaryPath = join(repoDir, primaryRelativePath);
  if (existsSync(primaryPath)) {
    return primaryRelativePath;
  }

  const legacyPath = join(repoDir, legacyRelativePath);
  if (existsSync(legacyPath)) {
    return legacyRelativePath;
  }

  if (existsSync(join(repoDir, "memory"))) {
    return legacyRelativePath;
  }

  return primaryRelativePath;
}

function getPersonaRelativePathForRepo(repoDir: string): string {
  return getMemoryFileRelativePathForRepo(
    repoDir,
    ROOT_PERSONA_RELATIVE_PATH,
    PRIMARY_PERSONA_RELATIVE_PATH,
    LEGACY_PERSONA_RELATIVE_PATH,
  );
}

function getHumanRelativePathForRepo(repoDir: string): string {
  return getMemoryFileRelativePathForRepo(
    repoDir,
    ROOT_HUMAN_RELATIVE_PATH,
    PRIMARY_HUMAN_RELATIVE_PATH,
    LEGACY_HUMAN_RELATIVE_PATH,
  );
}

async function resolvePersonalityMemoryPromptMode(
  environment: PersonalityEnvironment,
): Promise<CreateAgentOptions["memoryPromptMode"]> {
  if (environment === "local") return "local-memfs";
  try {
    return (await isLettaCloud()) ? "root-memfs" : "memfs";
  } catch {
    return isCloudServerUrl() ? "root-memfs" : "memfs";
  }
}

export async function buildCreateAgentOptionsForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  tags?: string[];
  environment?: PersonalityEnvironment;
}): Promise<CreateAgentOptions> {
  const { personalityId, name, description, model, tags } = params;
  const personality = getPersonalityOption(personalityId);
  const defaultMemoryBlocks = await getDefaultMemoryBlocks();
  const environment =
    params.environment ??
    (getBackend().capabilities.localMemfs ? "local" : "cloud");

  return {
    name: name ?? personality.label,
    description: description ?? personality.description,
    model: model ?? personality.defaultModel,
    tags: [...getPersonalityCreationTags(personalityId), ...(tags ?? [])],
    memoryPromptMode: await resolvePersonalityMemoryPromptMode(environment),
    memoryBlocks: buildPersonalityMemoryBlocks(
      personalityId,
      defaultMemoryBlocks,
      environment,
    ),
  };
}

export async function enableMemfsForCreatedAgent(params: {
  agentId: string;
  agentTags?: string[] | null;
}): Promise<void> {
  const { agentId, agentTags } = params;

  try {
    const backend = getBackend();
    if (!backend.capabilities.remoteMemfs) {
      if (backend.capabilities.localMemfs) {
        settingsManager.setMemfsEnabled(agentId, true);
      }
      return;
    }

    const { getClient } = await import("@/backend/api/client");
    const client = await getClient();
    let currentTags = agentTags;
    if (!currentTags) {
      try {
        const agent = await client.agents.retrieve(agentId, {
          include: ["agent.tags"],
        });
        currentTags = agent.tags ?? [];
      } catch {
        currentTags = [];
      }
    }
    const tags = Array.from(new Set([...currentTags, LETTA_CODE_ORIGIN_TAG]));
    if (
      !tags.includes(GIT_MEMORY_ENABLED_TAG) ||
      !currentTags.includes(LETTA_CODE_ORIGIN_TAG)
    ) {
      await client.agents.update(agentId, {
        tags: Array.from(new Set([...tags, GIT_MEMORY_ENABLED_TAG])),
      });
    }
    settingsManager.setMemfsEnabled(agentId, true);
  } catch {}
}

export async function createAgentForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  tags?: string[];
}): Promise<
  Awaited<ReturnType<typeof import("@/agent/create")["createAgent"]>>
> {
  const { createAgent } = await import("@/agent/create");
  const createOptions = await buildCreateAgentOptionsForPersonality(params);
  const result = await createAgent(createOptions);

  await enableMemfsForCreatedAgent({
    agentId: result.agent.id,
    agentTags: result.agent.tags,
  });

  if (getPersonalityDefaultMemoryFiles(params.personalityId).length > 0) {
    const { enableMemfsIfCloud } = await import("@/agent/memory-filesystem");
    await enableMemfsIfCloud(result.agent.id, {
      agentTags: result.agent.tags,
    });
  }

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

async function getMemoryCommitAuthor(agentId: string): Promise<{
  agentId: string;
  authorName: string;
  authorEmail: string;
}> {
  let authorName = agentId;

  try {
    const agent = await getBackend().retrieveAgent(agentId);
    if (agent.name?.trim()) {
      authorName = agent.name.trim();
    }
  } catch {}

  return {
    agentId,
    authorName,
    authorEmail: `${agentId}@letta.com`,
  };
}

function buildRootMemoryFile(
  relativePath: string,
  templatePromptAssetName: string,
  body: string,
  description?: string,
): string {
  const { frontmatter, body: normalizedBody } = parseMdxFrontmatter(
    buildDefaultMemoryFile(templatePromptAssetName, body, description),
  );
  const name = memoryNameFromPath(basename(relativePath));
  return `${serializeFrontmatter({
    name,
    description: frontmatter.description?.trim() || name,
  })}\n\n${ensureTrailingNewline(normalizedBody.trim())}`;
}

interface PersonalityFileUndo {
  absolutePath: string;
  previousContent: string | null;
  createdDirs: string[];
}

function applyPersonalityFiles(
  filesToUpdate: Array<{
    relativePath: string;
    absolutePath: string;
    templatePromptAssetName: string;
    content: string;
    description?: string;
    onlyIfBlank?: boolean;
  }>,
  undoLog: PersonalityFileUndo[],
): string[] {
  const changedPaths: string[] = [];

  for (const file of filesToUpdate) {
    const existingContent = existsSync(file.absolutePath)
      ? readFileSync(file.absolutePath, "utf-8")
      : null;
    if (
      file.onlyIfBlank &&
      existingContent !== null &&
      existingContent.replace(FRONTMATTER_REGEX, "").trim()
    ) {
      continue;
    }
    const nextContent = existingContent
      ? replaceBodyPreservingFrontmatter(existingContent, file.content, {
          description: file.description,
        })
      : file.relativePath.includes("/")
        ? buildDefaultMemoryFile(
            file.templatePromptAssetName,
            file.content,
            file.description,
          )
        : buildRootMemoryFile(
            file.relativePath,
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

    const createdDirs: string[] = [];
    for (
      let dir = dirname(file.absolutePath);
      !existsSync(dir);
      dir = dirname(dir)
    ) {
      createdDirs.push(dir);
    }
    undoLog.push({
      absolutePath: file.absolutePath,
      previousContent: existingContent,
      createdDirs,
    });
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, nextContent, "utf-8");
    changedPaths.push(file.relativePath);
  }

  return changedPaths;
}

async function undoPersonalityFiles(
  repoDir: string,
  undoLog: PersonalityFileUndo[],
): Promise<void> {
  if (undoLog.length === 0) return;
  for (const entry of [...undoLog].reverse()) {
    try {
      if (entry.previousContent === null) {
        rmSync(entry.absolutePath, { force: true });
      } else {
        writeFileSync(entry.absolutePath, entry.previousContent, "utf-8");
      }
      for (const dir of entry.createdDirs) {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      }
    } catch {}
  }
  try {
    await execFile(
      "git",
      ["reset", "-q", "--", ...undoLog.map((entry) => entry.absolutePath)],
      { cwd: repoDir, timeout: 10_000 },
    );
  } catch {}
}

export async function applyPersonalityToMemory(
  params: ApplyPersonalityToMemoryParams,
): Promise<ApplyPersonalityToMemoryResult> {
  const personality = getPersonalityOption(params.personalityId);
  const isLocalMemfs = getBackend().capabilities.localMemfs;
  const blockDefinitions = getPersonalityBlockDefinitions(
    params.personalityId,
    isLocalMemfs ? "local" : "cloud",
  );

  const repoDir = isLocalMemfs
    ? getScopedMemoryFilesystemRoot(params.agentId)
    : getMemoryRepoDir(params.agentId);

  const statusResult = await execFile("git", ["status", "--porcelain"], {
    cwd: repoDir,
    timeout: 10_000,
  });
  if (statusResult.stdout?.toString().trim()) {
    throw new Error(
      "Memory repo has uncommitted changes. Commit or discard them before switching personality.",
    );
  }

  if (!isLocalMemfs) {
    await pullMemory(params.agentId);
  }

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
      onlyIfBlank: true,
    },
  ];

  const commitMessage =
    params.commitMessage ??
    `chore(personality): switch to ${personality.label}`;

  const undoLog: PersonalityFileUndo[] = [];
  let commitResult: Awaited<ReturnType<typeof commitMemoryWrite>> | null = null;
  try {
    const changedPaths = applyPersonalityFiles(filesToUpdate, undoLog);
    if (changedPaths.length > 0) {
      const author = await getMemoryCommitAuthor(params.agentId);
      commitResult = await commitMemoryWrite({
        memoryDir: repoDir,
        pathspecs: changedPaths,
        reason: commitMessage,
        author,
        syncMode: isLocalMemfs ? "local" : "remote",
      });
    }
  } catch (error) {
    await undoPersonalityFiles(repoDir, undoLog);
    throw error;
  }

  if (!commitResult) {
    return {
      changed: false,
      personality,
      personaRelativePath,
      humanRelativePath,
    };
  }

  if (!commitResult.committed) {
    await undoPersonalityFiles(repoDir, undoLog);
    return {
      changed: false,
      personality,
      personaRelativePath,
      humanRelativePath,
    };
  }

  return {
    changed: true,
    personality,
    personaRelativePath,
    humanRelativePath,
    commitMessage,
  };
}
