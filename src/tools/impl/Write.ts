import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getCurrentAgentId } from "../../agent/context";
import { hasFileChanged, updateFileHash } from "../file-tracker";
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
  if (!path.isAbsolute(file_path))
    throw new Error(`File path must be absolute, got: ${file_path}`);
  try {
    const dir = path.dirname(file_path);
    await fs.mkdir(dir, { recursive: true });

    // Check if file exists and if agent has read it before
    let fileExists = false;
    try {
      const stats = await fs.stat(file_path);
      if (stats.isDirectory())
        throw new Error(`Path is a directory, not a file: ${file_path}`);
      fileExists = true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }

    // Check for conflicts if file exists and we're tracking this agent's files
    const agentId = getCurrentAgentId();
    if (agentId && fileExists) {
      const fileChanged = await hasFileChanged(agentId, file_path);
      if (fileChanged) {
        throw new Error(
          `File has been modified since read, either by the user, another subagent, or by a linter. ` +
            `Read it again before attempting to write it.`,
        );
      }
    }

    await fs.writeFile(file_path, content, "utf-8");

    // Update file hash after successful write
    if (agentId) {
      await updateFileHash(agentId, file_path);
    }
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
