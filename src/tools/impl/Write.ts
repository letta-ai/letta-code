import { promises as fs } from "node:fs";
import * as path from "node:path";

interface WriteArgs {
  file_path: string;
  content: string;
}
interface WriteResult {
  message: string;
}

export async function write(args: WriteArgs): Promise<WriteResult> {
  const { file_path, content } = args;
  if (!path.isAbsolute(file_path))
    throw new Error(`File path must be absolute, got: ${file_path}`);
  try {
    const dir = path.dirname(file_path);
    await fs.mkdir(dir, { recursive: true });
    try {
      const stats = await fs.stat(file_path);
      if (stats.isDirectory())
        throw new Error(`Path is a directory, not a file: ${file_path}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }
    await fs.writeFile(file_path, content, "utf-8");
    return {
      message: `Successfully wrote ${content.length} characters to ${file_path}`,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EACCES")
      throw new Error(`Permission denied: ${file_path}`);
    else if (err.code === "ENOSPC")
      throw new Error(`No space left on device: ${file_path}`);
    else if (err.code === "EISDIR")
      throw new Error(`Path is a directory: ${file_path}`);
    else if (err.message) throw err;
    else throw new Error(`Failed to write file: ${err}`);
  }
}
