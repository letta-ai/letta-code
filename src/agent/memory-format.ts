import { existsSync } from "node:fs";
import { join } from "node:path";

export type LocalMemoryFormat = "memfs-v1" | "memfs-v2";

export function detectMemoryFormat(
  memoryDir: string,
  localMemfs: boolean,
): LocalMemoryFormat {
  return !localMemfs && existsSync(join(memoryDir, "MEMORY.md"))
    ? "memfs-v2"
    : "memfs-v1";
}

export function isCoreMemoryPath(
  relativePath: string,
  format: LocalMemoryFormat,
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) return false;
  if (format === "memfs-v2") return !normalized.includes("/");
  return normalized.startsWith("system/");
}

export function isProjectedMemoryPath(
  relativePath: string,
  allPaths: ReadonlySet<string>,
  format: LocalMemoryFormat,
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (format === "memfs-v1") return true;
  if (normalized === "skills" || normalized.startsWith("skills/")) return false;
  if (!normalized.includes("/")) return true;

  const parts = normalized.split("/");
  const directories = parts.slice(0, -1);
  let current = "";
  for (const directory of directories) {
    current = current ? `${current}/${directory}` : directory;
    if (!allPaths.has(`${current}/MEMORY.md`)) return false;
  }
  return true;
}
