import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { getEffectiveAgentSkillsDir } from "./skills";

export interface SkillSchema {
  name: string;
  files?: Record<string, string>;
  source_url?: string;
}

/**
 * Package skills from .skills/ and ~/.letta/skills directories
 * Returns skills ready for .af export
 * Automatically uses source_url for skills found in known repos
 */
export async function packageSkills(
  agentId?: string,
  skillsDir?: string,
): Promise<SkillSchema[]> {
  const skills: SkillSchema[] = [];
  const skillNames = new Set<string>();

  // Directories to check (in priority order)
  // If explicit skillsDir provided, only check that directory
  const dirsToCheck = skillsDir
    ? [skillsDir]
    : [
        agentId && getEffectiveAgentSkillsDir(agentId),
        resolve(process.cwd(), ".skills"), // Project-local
        resolve(process.env.HOME || "~", ".letta", "skills"), // Global
      ].filter((dir): dir is string => Boolean(dir));

  for (const baseDir of dirsToCheck) {
    try {
      const entries = await readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Skip if already processed (project-local takes priority)
        if (skillNames.has(entry.name)) continue;

        const skillDir = resolve(baseDir, entry.name);

        // Validate SKILL.md exists
        const skillMdPath = resolve(skillDir, "SKILL.md");
        try {
          await readFile(skillMdPath, "utf-8");
        } catch {
          console.warn(
            `Skipping invalid skill ${entry.name}: missing SKILL.md`,
          );
          continue;
        }

        // Check if skill exists in known repos (prefer source_url over embedding).
        // When an explicit skillsDir is provided, skip network lookup and always
        // package local files for deterministic behavior (especially in tests).
        const sourceUrl = skillsDir
          ? null
          : await findSkillSourceUrl(entry.name);

        const skill: SkillSchema = { name: entry.name };

        if (sourceUrl) {
          skill.source_url = sourceUrl;
        } else {
          skill.files = await readSkillFiles(skillDir);
        }

        skills.push(skill);
        skillNames.add(entry.name);
      }
    } catch (error) {
      // Directory doesn't exist - continue to next
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return skills;
}

/**
 * Recursively read all files from a skill directory
 * Returns map of relative paths to file contents
 */
async function readSkillFiles(
  skillDir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const content = await readFile(fullPath, "utf-8");
        const relativePath = relative(skillDir, fullPath).replace(/\\/g, "/");
        files[relativePath] = content;
      }
    }
  }

  await walk(skillDir);
  return files;
}

// Known skill repositories to check
const SKILL_REPOS = [
  "letta-ai/skills/main/tools",
  "letta-ai/skills/main/letta",
  "anthropics/skills/main/skills",
] as const;

// Cache for skill directory listings
const dirCache = new Map<string, Set<string>>();

/**
 * Check if skill exists in known repos
 * Returns source_url if found, null otherwise
 */
async function findSkillSourceUrl(skillName: string): Promise<string | null> {
  for (const repoPath of SKILL_REPOS) {
    if (!dirCache.has(repoPath)) {
      dirCache.set(repoPath, await fetchGitHubDirs(repoPath));
    }

    if (dirCache.get(repoPath)?.has(skillName)) {
      return `${repoPath}/${skillName}`;
    }
  }

  return null;
}

/**
 * Fetch directory names from GitHub path
 */
async function fetchGitHubDirs(path: string): Promise<Set<string>> {
  const [owner, repo, branch, ...pathParts] = path.split("/");
  if (!owner || !repo || !branch) return new Set();

  try {
    const { fetchGitHubContents, parseDirNames } = await import(
      "./github-utils"
    );
    const entries = await fetchGitHubContents(
      owner,
      repo,
      branch,
      pathParts.join("/"),
    );
    return parseDirNames(entries);
  } catch {
    return new Set();
  }
}
