import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface WriteArgs {
  file_path: string;
  content: string;
}
interface WriteResult {
  message: string;
}

export async function write(args: WriteArgs): Promise<WriteResult> {
  validateRequiredParams(args, ["file_path", "content"], "Write");
  const { file_path, content } = args;
  const userCwd = process.env.USER_CWD || process.cwd();
  const resolvedPath = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(userCwd, file_path);
  try {
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    try {
      const stats = await fs.stat(resolvedPath);
      if (stats.isDirectory())
        throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }
    await fs.writeFile(resolvedPath, content, "utf-8");
    return {
      message: `Successfully wrote ${content.length} characters to ${resolvedPath}`,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EACCES")
      throw new Error(`Permission denied: ${resolvedPath}`);
    else if (err.code === "ENOSPC")
      throw new Error(`No space left on device: ${resolvedPath}`);
    else if (err.code === "EISDIR")
      throw new Error(`Path is a directory: ${resolvedPath}`);
    else if (err.message) throw err;
    else throw new Error(`Failed to write file: ${err}`);
  }
}
