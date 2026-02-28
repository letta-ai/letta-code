/**
 * Import an agent from an AgentFile (.af) template
 */
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "./client";
import { getModelUpdateArgs } from "./model";
import { updateAgentLLMConfig } from "./modify";

export interface ImportAgentOptions {
  filePath: string;
  modelOverride?: string;
  stripMessages?: boolean;
  stripSkills?: boolean;
}

export interface ImportFromRegistryOptions {
  handle: string; // e.g., "@cpfiffer/co-3"
  modelOverride?: string;
  stripMessages?: boolean;
  stripSkills?: boolean;
}

export interface ImportAgentResult {
  agent: AgentState;
  skills?: string[];
}

export async function importAgentFromFile(
  options: ImportAgentOptions,
): Promise<ImportAgentResult> {
  const client = await getClient();
  const resolvedPath = resolve(options.filePath);

  // Create a file stream for the API (compatible with Node.js and Bun)
  const file = createReadStream(resolvedPath);

  // Import the agent via API
  const importResponse = await client.agents.importFile({
    file: file,
    strip_messages: options.stripMessages ?? true,
    override_existing_tools: false,
  });

  if (!importResponse.agent_ids || importResponse.agent_ids.length === 0) {
    throw new Error("Import failed: no agent IDs returned");
  }

  const agentId = importResponse.agent_ids[0] as string;
  let agent = await client.agents.retrieve(agentId);

  // Override model if specified
  if (options.modelOverride) {
    const updateArgs = getModelUpdateArgs(options.modelOverride);
    await updateAgentLLMConfig(agentId, options.modelOverride, updateArgs);
    // Ensure the correct memory tool is attached for the new model
    const { ensureCorrectMemoryTool } = await import("../tools/toolset");
    await ensureCorrectMemoryTool(agentId, options.modelOverride);
    agent = await client.agents.retrieve(agentId);
  }

  // Extract skills from .af file if present (unless stripSkills=true)
  let skills: string[] | undefined;

  if (!options.stripSkills) {
    const { getEffectiveAgentSkillsDir } = await import("./skills");
    const skillsDir = getEffectiveAgentSkillsDir(agentId);
    skills = await extractSkillsFromAf(resolvedPath, skillsDir);
  }

  return { agent, skills };
}

/**
 * Extract skills from an AgentFile and write to destination directory
 * Always overwrites existing skills
 * Supports both embedded files and remote source_url
 */
export async function extractSkillsFromAf(
  afPath: string,
  destDir: string,
): Promise<string[]> {
  const extracted: string[] = [];

  // Read and parse .af file
  const content = await readFile(afPath, "utf-8");
  const afData = JSON.parse(content);

  if (!afData.skills || !Array.isArray(afData.skills)) {
    return [];
  }

  for (const skill of afData.skills) {
    const skillDir = resolve(destDir, skill.name);
    await mkdir(skillDir, { recursive: true });

    // Case 1: Files are embedded in .af
    if (skill.files) {
      await writeSkillFiles(skillDir, skill.files);
      extracted.push(skill.name);
    }
    // Case 2: Skill should be fetched from source_url
    else if (skill.source_url) {
      await fetchSkillFromUrl(skillDir, skill.source_url);
      extracted.push(skill.name);
    } else {
      console.warn(`Skipping skill ${skill.name}: no files or source_url`);
    }
  }

  return extracted;
}

/**
 * Write skill files to disk from embedded content
 */
async function writeSkillFiles(
  skillDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [filePath, fileContent] of Object.entries(files)) {
    await writeSkillFile(skillDir, filePath, fileContent);
  }
}

/**
 * Write a single skill file with appropriate permissions
 */
async function writeSkillFile(
  skillDir: string,
  filePath: string,
  content: string,
): Promise<void> {
  const fullPath = resolve(skillDir, filePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");

  const isScript =
    filePath.startsWith("scripts/") || content.trimStart().startsWith("#!");
  if (isScript) {
    try {
      await chmod(fullPath, 0o755);
    } catch {
      // chmod not supported on Windows - skip silently
    }
  }
}

/**
 * Fetch skill from remote source_url and write to disk
 * Supports formats:
 * - "owner/repo/branch/path" (standard - what export generates)
 * - "github.com/owner/repo/tree/branch/path" (normalized from GitHub URLs)
 */
async function fetchSkillFromUrl(
  skillDir: string,
  sourceUrl: string,
): Promise<void> {
  // Normalize GitHub URLs (github.com/... → owner/repo/branch/path)
  const githubPath = sourceUrl
    .replace(/^github\.com\//, "")
    .replace(/\/tree\//, "/");

  // Fetch directory listing from GitHub API
  const parts = githubPath.split("/");
  if (parts.length < 4 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(`Invalid GitHub path: ${githubPath}`);
  }

  const owner = parts[0];
  const repo = parts[1];
  const branch = parts[2];
  const path = parts.slice(3).join("/");

  // Fetch contents using shared GitHub util
  const { fetchGitHubContents } = await import("./github-utils");
  const entries = await fetchGitHubContents(owner, repo, branch, path);

  if (!Array.isArray(entries)) {
    throw new Error(`Expected directory at ${sourceUrl}, got file`);
  }

  // Download all files recursively
  await downloadGitHubDirectory(entries, skillDir, owner, repo, branch, path);
}

/**
 * Recursively download files from GitHub directory
 */
async function downloadGitHubDirectory(
  entries: Array<{ type: "file" | "dir"; path: string; download_url?: string }>,
  destDir: string,
  owner: string,
  repo: string,
  branch: string,
  basePath: string,
): Promise<void> {
  const { fetchGitHubContents } = await import("./github-utils");

  for (const entry of entries) {
    if (entry.type === "file") {
      if (!entry.download_url) {
        throw new Error(`Missing download_url for file: ${entry.path}`);
      }
      const fileResponse = await fetch(entry.download_url);
      const fileContent = await fileResponse.text();
      const relativePath = entry.path.replace(`${basePath}/`, "");
      await writeSkillFile(destDir, relativePath, fileContent);
    } else if (entry.type === "dir") {
      // Recursively fetch subdirectory using shared util
      const subEntries = await fetchGitHubContents(
        owner,
        repo,
        branch,
        entry.path,
      );
      await downloadGitHubDirectory(
        subEntries,
        destDir,
        owner,
        repo,
        branch,
        basePath,
      );
    }
  }
}

/**
 * Registry constants
 */
const AGENT_REGISTRY_OWNER = "letta-ai";
const AGENT_REGISTRY_REPO = "agent-file";
const AGENT_REGISTRY_BRANCH = "main";

/**
 * Parse a registry handle (e.g., "@cpfiffer/co-3") into author and agent name
 */
function parseRegistryHandle(handle: string): { author: string; name: string } {
  // Handle can be "@author/name" or "author/name"
  const normalized = handle.startsWith("@") ? handle.slice(1) : handle;
  const parts = normalized.split("/");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid import handle "${handle}". Use format: @author/agentname`,
    );
  }

  return { author: parts[0], name: parts[1] };
}

/**
 * Import an agent from the letta-ai/agent-file registry
 * Downloads the .af file from GitHub and imports it
 */
export async function importAgentFromRegistry(
  options: ImportFromRegistryOptions,
): Promise<ImportAgentResult> {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeFile, unlink } = await import("node:fs/promises");

  const { author, name } = parseRegistryHandle(options.handle);

  // Construct the raw GitHub URL
  // Pattern: agents/@{author}/{name}/{name}.af
  const rawUrl = `https://raw.githubusercontent.com/${AGENT_REGISTRY_OWNER}/${AGENT_REGISTRY_REPO}/refs/heads/${AGENT_REGISTRY_BRANCH}/agents/@${author}/${name}/${name}.af`;

  // Download the .af file
  const response = await fetch(rawUrl);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Agent @${author}/${name} not found in registry. Check that the agent exists at https://github.com/${AGENT_REGISTRY_OWNER}/${AGENT_REGISTRY_REPO}/tree/${AGENT_REGISTRY_BRANCH}/agents/@${author}/${name}`,
      );
    }
    throw new Error(
      `Failed to download agent @${author}/${name}: ${response.statusText}`,
    );
  }

  const afContent = await response.text();

  // Write to a temp file
  const tempPath = join(
    tmpdir(),
    `letta-import-${author}-${name}-${Date.now()}.af`,
  );
  await writeFile(tempPath, afContent, "utf-8");

  try {
    // Import using the existing file-based import
    const result = await importAgentFromFile({
      filePath: tempPath,
      modelOverride: options.modelOverride,
      stripMessages: options.stripMessages ?? true,
      stripSkills: options.stripSkills ?? false,
    });

    return result;
  } finally {
    // Clean up temp file
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
