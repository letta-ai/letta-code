export const LOCAL_AGENT_MEMORY_ENV = "LETTA_LOCAL_AGENT_MEMORY";

const ENABLED_VALUES = new Set(["1", "true", "yes"]);

export function isLocalAgentMemoryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[LOCAL_AGENT_MEMORY_ENV];
  return value !== undefined && ENABLED_VALUES.has(value.trim().toLowerCase());
}

export function localMemoryMode(): "local-memfs" | "local-agent-memory" {
  return isLocalAgentMemoryEnabled() ? "local-agent-memory" : "local-memfs";
}

export function isAgentSkillsPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized === "skills" || normalized.startsWith("skills/");
}

export async function ensureAgentMemoryIndexes(
  memoryDir: string,
  relativePaths: string[],
): Promise<string[]> {
  if (!isLocalAgentMemoryEnabled()) return [];

  const directories = new Set<string>([""]);
  for (const relativePath of relativePaths) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (isAgentSkillsPath(normalized) || !normalized.endsWith(".md")) continue;
    let directory = dirname(normalized).replaceAll("\\", "/");
    while (directory !== "." && directory !== "") {
      directories.add(directory);
      directory = dirname(directory).replaceAll("\\", "/");
    }
  }

  const created: string[] = [];
  for (const directory of [...directories].sort()) {
    const relativePath = directory ? `${directory}/MEMORY.md` : "MEMORY.md";
    const absolutePath = join(memoryDir, relativePath);
    if (existsSync(absolutePath)) continue;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      "# Memory\n\nRead the files in this directory when they are relevant.\n",
      "utf8",
    );
    created.push(relativePath);
  }
  return created;
}

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
