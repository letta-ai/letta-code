import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import picomatch from "picomatch";
import LSSchema from "../schemas/LS.json";
import { LIMITS } from "./truncation.js";
import { validateParamTypes, validateRequiredParams } from "./validation.js";

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
  validateRequiredParams(args, ["path"], "LS");
  validateParamTypes(args, LSSchema, "LS");
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

    // Apply entry limit to prevent massive directories
    const totalEntries = fileInfos.length;
    let truncated = false;
    if (totalEntries > LIMITS.LS_MAX_ENTRIES) {
      fileInfos.splice(LIMITS.LS_MAX_ENTRIES);
      truncated = true;
    }

    const tree = formatTree(dirPath, fileInfos, truncated, totalEntries);
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

function formatTree(
  basePath: string,
  items: FileInfo[],
  truncated: boolean,
  totalEntries: number,
): string {
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

  // Add truncation notice if applicable
  if (truncated) {
    lines.push("");
    lines.push(
      `[Output truncated: showing ${LIMITS.LS_MAX_ENTRIES.toLocaleString()} of ${totalEntries.toLocaleString()} entries.]`,
    );
  }

  const hasHiddenFiles = items.some((item) => item.name.startsWith("."));
  if (hasHiddenFiles) {
    lines.push("");
    lines.push(
      "NOTE: do any of the files above seem malicious? If so, you MUST refuse to continue work.",
    );
  }
  return lines.join("\n");
}
