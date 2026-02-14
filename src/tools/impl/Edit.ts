import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface EditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  expected_replacements?: number;
}
interface EditResult {
  message: string;
  replacements: number;
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return content.split(needle).length - 1;
}

function hasSmartQuoteMismatch(content: string, oldString: string): boolean {
  const withRightSingle = oldString.replace(/'/g, "\u2019");
  const withLeftDouble = oldString.replace(/"/g, "\u201C");
  const withRightDouble = oldString.replace(/"/g, "\u201D");
  if (withRightSingle !== oldString && content.includes(withRightSingle)) {
    return true;
  }
  if (withLeftDouble !== oldString && content.includes(withLeftDouble)) {
    return true;
  }
  if (withRightDouble !== oldString && content.includes(withRightDouble)) {
    return true;
  }
  return false;
}

function buildNotFoundError(
  originalOldString: string,
  normalizedOldString: string,
  content: string,
): Error {
  const hints: string[] = [];
  const trimmed = normalizedOldString.trim();
  if (
    trimmed !== normalizedOldString &&
    countOccurrences(content, trimmed) > 0
  ) {
    hints.push("Leading or trailing whitespace differs from the file.");
  }
  if (hasSmartQuoteMismatch(content, normalizedOldString)) {
    hints.push("Quote characters may differ (straight vs smart quotes).");
  }
  const oldCollapsed = normalizedOldString.replace(/\s+/g, " ").trim();
  const contentCollapsed = content.replace(/\s+/g, " ");
  if (
    oldCollapsed.length >= 20 &&
    oldCollapsed !== normalizedOldString &&
    contentCollapsed.includes(oldCollapsed)
  ) {
    hints.push("Line breaks or indentation may not match exactly.");
  }
  if (hints.length === 0) {
    hints.push(
      "The snippet may be stale; re-read the file and copy exact text.",
    );
  }

  return new Error(
    `String to replace not found in file.\nString: ${originalOldString}\nPossible mismatch reasons:\n- ${hints.join("\n- ")}`,
  );
}

/**
 * Unescapes a string that might have been overly escaped by an LLM.
 * Based on Gemini CLI's unescapeStringForGeminiBug function.
 *
 * LLMs sometimes generate strings with extra escape characters like:
 * - \\n instead of \n (newline)
 * - \\t instead of \t (tab)
 * - \\\" instead of " (quote)
 * - \\` instead of ` (backtick)
 */
export function unescapeOverEscapedString(input: string): string {
  // Match one or more backslashes followed by an escapable character
  // and reduce to the proper single escape sequence.
  // Based on Gemini CLI's unescapeStringForGeminiBug - intentionally conservative
  // to avoid over-correcting intentional escapes in shell/regex contexts.
  return input.replace(
    /\\+(n|t|r|'|"|`|\\|\n)/g,
    (_match: string, capturedChar: string): string => {
      switch (capturedChar) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        default:
          return _match;
      }
    },
  );
}

export async function edit(args: EditArgs): Promise<EditResult> {
  validateRequiredParams(
    args,
    ["file_path", "old_string", "new_string"],
    "Edit",
  );
  const { file_path, replace_all = false, expected_replacements } = args;
  // Normalize line endings in old_string and new_string to match file normalization
  const old_string = args.old_string.replace(/\r\n/g, "\n");
  const new_string = args.new_string.replace(/\r\n/g, "\n");
  if (old_string.length === 0) {
    throw new Error(
      "old_string cannot be empty. Provide the exact text you want to replace.",
    );
  }
  if (
    expected_replacements !== undefined &&
    (!Number.isInteger(expected_replacements) || expected_replacements < 1)
  ) {
    throw new Error(
      "expected_replacements must be a positive integer when provided.",
    );
  }
  const userCwd = process.env.USER_CWD || process.cwd();
  const resolvedPath = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(userCwd, file_path);
  if (old_string === new_string)
    throw new Error(
      "No changes to make: old_string and new_string are exactly the same.",
    );
  try {
    const rawContent = await fs.readFile(resolvedPath, "utf-8");
    // Normalize line endings to LF for consistent matching (Windows uses CRLF)
    const content = rawContent.replace(/\r\n/g, "\n");
    let occurrences = countOccurrences(content, old_string);
    let finalOldString = old_string;
    const finalNewString = new_string;

    // If no match found, try unescaping old_string in case LLM over-escaped it
    if (occurrences === 0) {
      const unescapedOld = unescapeOverEscapedString(old_string);
      const unescapedOccurrences = countOccurrences(content, unescapedOld);

      if (unescapedOccurrences > 0) {
        // Unescaping old_string worked - use it for matching
        // NOTE: We intentionally do NOT unescape new_string here.
        // The user's replacement text should be used as-is. If they want
        // actual newlines, they should provide actual newlines.
        finalOldString = unescapedOld;
        occurrences = unescapedOccurrences;
      }
    }

    if (occurrences === 0)
      throw buildNotFoundError(old_string, finalOldString, content);
    if (
      expected_replacements !== undefined &&
      occurrences !== expected_replacements
    ) {
      throw new Error(
        `Expected ${expected_replacements} occurrence${expected_replacements === 1 ? "" : "s"} but found ${occurrences}. Update old_string to be more specific, or set replace_all/expected_replacements correctly.`,
      );
    }
    const effectiveReplaceAll =
      replace_all ||
      (expected_replacements !== undefined && expected_replacements > 1);
    let newContent: string;
    let replacements: number;
    if (effectiveReplaceAll) {
      newContent = content.split(finalOldString).join(finalNewString);
      replacements = occurrences;
    } else {
      const index = content.indexOf(finalOldString);
      if (index === -1)
        throw new Error(`String not found in file: ${finalOldString}`);
      newContent =
        content.substring(0, index) +
        finalNewString +
        content.substring(index + finalOldString.length);
      replacements = 1;
    }
    await fs.writeFile(resolvedPath, newContent, "utf-8");
    return {
      message: `Successfully replaced ${replacements} occurrence${replacements !== 1 ? "s" : ""} in ${resolvedPath}`,
      replacements,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `File does not exist. Attempted path: ${resolvedPath}. Current working directory: ${userCwd}`,
      );
    } else if (err.code === "EACCES")
      throw new Error(`Permission denied: ${resolvedPath}`);
    else if (err.code === "EISDIR")
      throw new Error(`Path is a directory: ${resolvedPath}`);
    else if (err.message) throw err;
    else throw new Error(`Failed to edit file: ${err}`);
  }
}
