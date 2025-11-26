import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface EditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
interface EditResult {
  message: string;
  replacements: number;
}

export async function edit(args: EditArgs): Promise<EditResult> {
  validateRequiredParams(
    args,
    ["file_path", "old_string", "new_string"],
    "Edit",
  );
  const { file_path, old_string, new_string, replace_all = false } = args;
  if (!path.isAbsolute(file_path))
    throw new Error(`File path must be absolute, got: ${file_path}`);
  if (old_string === new_string)
    throw new Error(
      "No changes to make: old_string and new_string are exactly the same.",
    );
  try {
    const content = await fs.readFile(file_path, "utf-8");
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0)
      throw new Error(
        `String to replace not found in file.\nString: ${old_string}`,
      );
    let newContent: string;
    let replacements: number;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
      replacements = occurrences;
    } else {
      const index = content.indexOf(old_string);
      if (index === -1)
        throw new Error(`String not found in file: ${old_string}`);
      newContent =
        content.substring(0, index) +
        new_string +
        content.substring(index + old_string.length);
      replacements = 1;
    }
    await fs.writeFile(file_path, newContent, "utf-8");

    return {
      message: `Successfully replaced ${replacements} occurrence${replacements !== 1 ? "s" : ""} in ${file_path}`,
      replacements,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      const userCwd = process.env.USER_CWD || process.cwd();
      throw new Error(
        `File does not exist. Current working directory: ${userCwd}`,
      );
    } else if (err.code === "EACCES")
      throw new Error(`Permission denied: ${file_path}`);
    else if (err.code === "EISDIR")
      throw new Error(`Path is a directory: ${file_path}`);
    else if (err.message) throw err;
    else throw new Error(`Failed to edit file: ${err}`);
  }
}
