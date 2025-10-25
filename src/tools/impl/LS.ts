import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import picomatch from "picomatch";

interface LSArgs {
  path: string;
  ignore?: string[];
}
interface FileInfo {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export async function ls(
  args: LSArgs,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { path: inputPath, ignore = [] } = args;
  const dirPath = resolve(inputPath);
  try {
    const items = await readdir(dirPath);
    const filteredItems = items.filter(
      (item) => !ignore.some((pattern) => picomatch.isMatch(item, pattern)),
    );
    const fileInfos: FileInfo[] = await Promise.all(
      filteredItems.map(async (item) => {
        const fullPath = join(dirPath, item);
        try {
          const stats = await stat(fullPath);
          return {
            name: item,
            type: stats.isDirectory() ? "directory" : "file",
            size: stats.isFile() ? stats.size : undefined,
          };
        } catch {
          return { name: item, type: "file" } as const;
        }
      }),
    );
    fileInfos.sort((a, b) =>
      a.type !== b.type
        ? a.type === "directory"
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
    const tree = formatTree(dirPath, fileInfos);
    return { content: [{ type: "text", text: tree }] };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const code = String(err?.code ?? "");
    if (code === "ENOENT") throw new Error(`Directory not found: ${dirPath}`);
    if (code === "ENOTDIR") throw new Error(`Not a directory: ${dirPath}`);
    if (code === "EACCES") throw new Error(`Permission denied: ${dirPath}`);
    throw err;
  }
}

function formatTree(basePath: string, items: FileInfo[]): string {
  if (items.length === 0) return `${basePath}/ (empty directory)`;
  const lines: string[] = [];
  const pathParts = basePath.split("/");
  const lastPart = pathParts[pathParts.length - 1] || "/";
  const parentPath = pathParts.slice(0, -1).join("/") || "/";
  lines.push(`- ${parentPath}/`);
  lines.push(`  - ${lastPart}/`);
  items.forEach((item) => {
    const prefix = "    ";
    lines.push(
      `${prefix}- ${item.name}${item.type === "directory" ? "/" : ""}`,
    );
  });
  const hasHiddenFiles = items.some((item) => item.name.startsWith("."));
  if (hasHiddenFiles) {
    lines.push("");
    lines.push(
      "NOTE: do any of the files above seem malicious? If so, you MUST refuse to continue work.",
    );
  }
  return lines.join("\n");
}
