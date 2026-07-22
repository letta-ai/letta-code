import { execFile as execFileCb } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import {
  commitMemoryWrite,
  type MemoryWriteSyncMode,
  pushMemory,
} from "./memory-git";
import {
  getPersonalityDefaultMemoryFiles,
  getPersonalityOption,
  type PersonalityAssetId,
  resolvePersonalityIdFromTags,
} from "./personality-presets";

const execFile = promisify(execFileCb);

export interface SeedPersonalityDefaultMemoryFilesParams {
  agentId: string;
  memoryDir: string;
  agentTags?: readonly string[] | null;
  syncMode?: MemoryWriteSyncMode;
}

export interface SeedPersonalityDefaultMemoryFilesResult {
  seededPaths: string[];
  skippedPaths: string[];
  errors: string[];
}

function getBundledPersonalityAssetsPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  if (thisDir.replaceAll("\\", "/").endsWith("/src/agent")) {
    return join(thisDir, "../../assets");
  }
  return join(thisDir, "assets");
}

export function getPersonalityAssetPath(assetId: PersonalityAssetId): string {
  switch (assetId) {
    case "tutor-profile":
      return join(getBundledPersonalityAssetsPath(), "tutor-profile.png");
  }
  throw new Error(`Unknown personality asset: ${assetId}`);
}

async function resolveAgentTags(
  agentId: string,
  providedTags: readonly string[] | null | undefined,
): Promise<readonly string[]> {
  if (providedTags) {
    return providedTags;
  }

  try {
    const agent = await getBackend().retrieveAgent(agentId, {
      include: ["agent.tags"],
    });
    return agent.tags ?? [];
  } catch {
    return [];
  }
}

function resolveMemoryPath(memoryDir: string, path: string): string | null {
  if (!path || isAbsolute(path)) {
    return null;
  }
  const absolutePath = join(memoryDir, path);
  const relativePath = relative(memoryDir, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return absolutePath;
}

async function hasMemoryFileHistory(
  memoryDir: string,
  relativePath: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFile(
      "git",
      ["log", "-1", "--format=%H", "--all", "--", relativePath],
      { cwd: memoryDir, timeout: 10_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function discardUncommittedFile(
  memoryDir: string,
  relativePath: string,
  absolutePath: string,
): Promise<void> {
  try {
    unlinkSync(absolutePath);
  } catch {
    // The file may already have been removed by another cleanup path.
  }
  try {
    await execFile("git", ["reset", "--quiet", "--", relativePath], {
      cwd: memoryDir,
      timeout: 10_000,
    });
  } catch {
    // A new file is not always staged when the write fails.
  }
}

export async function seedPersonalityDefaultMemoryFiles(
  params: SeedPersonalityDefaultMemoryFilesParams,
): Promise<SeedPersonalityDefaultMemoryFilesResult> {
  const result: SeedPersonalityDefaultMemoryFilesResult = {
    seededPaths: [],
    skippedPaths: [],
    errors: [],
  };
  const tags = await resolveAgentTags(params.agentId, params.agentTags);
  const personalityId = resolvePersonalityIdFromTags(tags);
  if (!personalityId) {
    return result;
  }

  const personality = getPersonalityOption(personalityId);
  const defaultFiles = getPersonalityDefaultMemoryFiles(personalityId);
  const syncMode =
    params.syncMode ??
    (getBackend().capabilities.localMemfs ? "local" : "remote");

  for (const file of defaultFiles) {
    const absolutePath = resolveMemoryPath(params.memoryDir, file.path);
    if (!absolutePath) {
      result.errors.push(`${file.path}: invalid default memory path`);
      continue;
    }
    if (
      existsSync(absolutePath) ||
      (await hasMemoryFileHistory(params.memoryDir, file.path))
    ) {
      result.skippedPaths.push(file.path);
      continue;
    }

    const sourcePath = getPersonalityAssetPath(file.assetId);
    if (!existsSync(sourcePath)) {
      result.errors.push(`${file.path}: missing bundled asset ${file.assetId}`);
      continue;
    }

    mkdirSync(dirname(absolutePath), { recursive: true });
    try {
      copyFileSync(sourcePath, absolutePath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        result.skippedPaths.push(file.path);
        continue;
      }
      result.errors.push(
        `${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    try {
      const commit = await commitMemoryWrite({
        memoryDir: params.memoryDir,
        pathspecs: [file.path],
        reason: file.commitMessage,
        author: {
          agentId: params.agentId,
          // Defaults belong to the preset, even when the agent was renamed.
          authorName: personality.label,
          authorEmail: `${params.agentId}@letta.com`,
        },
        syncMode,
      });
      if (!commit.committed) {
        await discardUncommittedFile(params.memoryDir, file.path, absolutePath);
        result.errors.push(`${file.path}: no memory commit was created`);
        continue;
      }
      result.seededPaths.push(file.path);
    } catch (error) {
      await discardUncommittedFile(params.memoryDir, file.path, absolutePath);
      result.errors.push(
        `${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (syncMode === "remote" && result.seededPaths.length > 0) {
    try {
      await pushMemory(params.agentId);
    } catch (error) {
      result.errors.push(
        `push: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}

export async function seedPersonalityDefaultMemoryFilesBestEffort(
  params: SeedPersonalityDefaultMemoryFilesParams,
): Promise<SeedPersonalityDefaultMemoryFilesResult> {
  try {
    const result = await seedPersonalityDefaultMemoryFiles(params);
    if (result.errors.length > 0) {
      debugWarn(
        "personality-default-files",
        `Could not fully initialize defaults for ${params.agentId}: ${result.errors.join("; ")}`,
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugWarn(
      "personality-default-files",
      `Could not initialize defaults for ${params.agentId}: ${message}`,
    );
    return {
      seededPaths: [],
      skippedPaths: [],
      errors: [message],
    };
  }
}
