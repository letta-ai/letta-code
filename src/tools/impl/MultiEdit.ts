import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface Edit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
export interface MultiEditArgs {
  file_path: string;
  edits: Edit[];
}
interface MultiEditResult {
  message: string;
  edits_applied: number;
}

export async function multi_edit(
  args: MultiEditArgs,
): Promise<MultiEditResult> {
  validateRequiredParams(args, ["file_path", "edits"], "MultiEdit");
  const { file_path, edits } = args;
  if (!path.isAbsolute(file_path))
    throw new Error(`File path must be absolute, got: ${file_path}`);
  if (!edits || edits.length === 0) throw new Error("No edits provided");
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit) {
      throw new Error(`Edit ${i + 1} is undefined`);
    }
    validateRequiredParams(
      edit as unknown as Record<string, unknown>,
      ["old_string", "new_string"],
      `MultiEdit (edit ${i + 1})`,
    );
    if (edit.old_string === edit.new_string)
      throw new Error(
        `Edit ${i + 1}: No changes to make: old_string and new_string are exactly the same.`,
      );
  }
  try {
    let content = await fs.readFile(file_path, "utf-8");
    const appliedEdits: string[] = [];
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      if (!edit) continue;
      const { old_string, new_string, replace_all = false } = edit;
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `Edit ${i + 1}: String to replace not found in file.\nString: ${old_string}`,
        );
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `Found ${occurrences} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
        );
      }
      if (replace_all) {
        content = content.split(old_string).join(new_string);
      } else {
        const index = content.indexOf(old_string);
        content =
          content.substring(0, index) +
          new_string +
          content.substring(index + old_string.length);
      }
      appliedEdits.push(
        `Replaced "${old_string.substring(0, 50)}${old_string.length > 50 ? "..." : ""}" with "${new_string.substring(0, 50)}${new_string.length > 50 ? "..." : ""}"`,
      );
    }
    await fs.writeFile(file_path, content, "utf-8");
    const editList = appliedEdits
      .map((edit, i) => `${i + 1}. ${edit}`)
      .join("\n");
    return {
      message: `Applied ${edits.length} edit${edits.length !== 1 ? "s" : ""} to ${file_path}:\n${editList}`,
      edits_applied: edits.length,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const code = String(err?.code ?? "");
    const message = String(err?.message ?? "");
    if (code === "ENOENT") {
      const userCwd = process.env.USER_CWD || process.cwd();
      throw new Error(
        `File does not exist. Current working directory: ${userCwd}`,
      );
    } else if (code === "EACCES")
      throw new Error(`Permission denied: ${file_path}`);
    else if (code === "EISDIR")
      throw new Error(`Path is a directory: ${file_path}`);
    else if (message) throw new Error(message);
    else throw new Error(`Failed to edit file: ${String(err)}`);
  }
}
