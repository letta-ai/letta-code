import { join } from "node:path";
import { PROJECT_SKILLS_DIR } from "@/agent/skills";
import { cloudSkillDirectoryRevision } from "@/utils/cloud-repository-roots";

export async function registerCodexRepositorySkills(
  repositoryRoots: readonly string[],
  setExtraRoots: (roots: string[]) => Promise<unknown>,
): Promise<(() => Promise<void>) | undefined> {
  const roots = repositoryRoots.map((root) => join(root, PROJECT_SKILLS_DIR));
  if (roots.length === 0) return undefined;

  const revision = () => JSON.stringify(roots.map(cloudSkillDirectoryRevision));
  let registered = revision();
  await setExtraRoots(roots);
  return async () => {
    const current = revision();
    if (current === registered) return;
    await setExtraRoots(roots);
    registered = current;
  };
}
