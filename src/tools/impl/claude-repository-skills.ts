import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export async function stageClaudeRepositorySkills(
  repositoryRoots: readonly string[],
): Promise<{ directories: string[]; cleanup: () => Promise<void> }> {
  const directories: string[] = [];
  let stagingRoot: string | undefined;
  const cleanup = async () => {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  };
  try {
    for (const repo of repositoryRoots) {
      for (const source of [".claude", ".agents"]) {
        const skills = join(repo, source, "skills");
        const info = await stat(skills).catch((error) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR")
            return undefined;
          throw error;
        });
        if (!info?.isDirectory()) continue;
        stagingRoot ??= await mkdtemp(join(tmpdir(), "letta-claude-skills-"));
        // Load only the skill directories and keep the checkout untouched.
        const directory = join(stagingRoot, source, basename(repo));
        const claudeDir = join(directory, ".claude");
        await mkdir(claudeDir, { recursive: true });
        await symlink(skills, join(claudeDir, "skills"), "dir");
        directories.push(directory);
      }
    }
    return { directories, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
