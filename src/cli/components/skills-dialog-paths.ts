import { join } from "node:path";
import { resolveScopedMemoryDir } from "@/agent/memory-filesystem";
import type { SkillSource } from "@/agent/skills";
import { getGlobalSkillsDir } from "@/agent/skills";

function displayDirectory(path: string): string {
  return `${path.replace(/\\/g, "/").replace(/\/$/, "")}/`;
}

export function getSkillsTabDescription(
  tab: SkillSource,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (tab) {
    case "project":
      return ".agents/skills/";
    case "agent": {
      const memoryDir = resolveScopedMemoryDir({ agentId, env });
      return memoryDir
        ? displayDirectory(join(memoryDir, "skills"))
        : "$MEMORY_DIR/skills/";
    }
    case "global":
      return displayDirectory(getGlobalSkillsDir(env));
    case "bundled":
      return "Built-in skills shipped with Letta Code";
  }
}

export function getSkillsCreationHint(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return ["project", "agent", "global"]
    .map((source) =>
      getSkillsTabDescription(source as SkillSource, agentId, env),
    )
    .join(", ");
}
