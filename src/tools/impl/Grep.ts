import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getRipgrepPath(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    const rgPackage = require("@vscode/ripgrep");
    return rgPackage.rgPath;
  } catch (_error) {
    return "rg";
  }
}

const rgPath = getRipgrepPath();

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  type?: string;
  multiline?: boolean;
}

interface GrepResult {
  output: string;
  matches?: number;
  files?: number;
}

export async function grep(args: GrepArgs): Promise<GrepResult> {
  const {
    pattern,
    path: searchPath,
    glob,
    output_mode = "files_with_matches",
    "-B": before,
    "-A": after,
    "-C": context,
    "-n": lineNumbers,
    "-i": ignoreCase,
    type: fileType,
    multiline,
  } = args;

  const userCwd = process.env.USER_CWD || process.cwd();
  const rgArgs: string[] = [];
  if (output_mode === "files_with_matches") rgArgs.push("-l");
  else if (output_mode === "count") rgArgs.push("-c");
  if (output_mode === "content") {
    if (context !== undefined) rgArgs.push("-C", context.toString());
    else {
      if (before !== undefined) rgArgs.push("-B", before.toString());
      if (after !== undefined) rgArgs.push("-A", after.toString());
    }
    if (lineNumbers) rgArgs.push("-n");
  }
  if (ignoreCase) rgArgs.push("-i");
  if (fileType) rgArgs.push("--type", fileType);
  if (glob) rgArgs.push("--glob", glob);
  if (multiline) rgArgs.push("-U", "--multiline-dotall");
  rgArgs.push(pattern);
  if (searchPath)
    rgArgs.push(
      path.isAbsolute(searchPath)
        ? searchPath
        : path.resolve(userCwd, searchPath),
    );
  else rgArgs.push(userCwd);

  try {
    const { stdout } = await execFileAsync(rgPath, rgArgs, {
      maxBuffer: 10 * 1024 * 1024,
      cwd: userCwd,
    });
    if (output_mode === "files_with_matches") {
      const files = stdout.trim().split("\n").filter(Boolean);
      const fileCount = files.length;
      if (fileCount === 0) return { output: "No files found", files: 0 };
      return {
        output: `Found ${fileCount} file${fileCount !== 1 ? "s" : ""}\n${files.join("\n")}`,
        files: fileCount,
      };
    } else if (output_mode === "count") {
      const lines = stdout.trim().split("\n").filter(Boolean);
      let totalMatches = 0;
      let filesWithMatches = 0;
      for (const line of lines) {
        const parts = line.split(":");
        if (parts.length >= 2) {
          const count = parseInt(parts[parts.length - 1], 10);
          if (!Number.isNaN(count) && count > 0) {
            totalMatches += count;
            filesWithMatches++;
          }
        }
      }
      if (totalMatches === 0)
        return {
          output: "0\n\nFound 0 total occurrences across 0 files.",
          matches: 0,
          files: 0,
        };
      const countOutput = lines.join("\n");
      return {
        output: `${countOutput}\n\nFound ${totalMatches} total occurrence${totalMatches !== 1 ? "s" : ""} across ${filesWithMatches} file${filesWithMatches !== 1 ? "s" : ""}.`,
        matches: totalMatches,
        files: filesWithMatches,
      };
    } else {
      if (!stdout || stdout.trim() === "")
        return { output: "No matches found", matches: 0 };
      return {
        output: stdout,
        matches: stdout.split("\n").filter(Boolean).length,
      };
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
    };
    const code = typeof err.code === "number" ? err.code : undefined;
    const _stdout = typeof err.stdout === "string" ? err.stdout : "";
    const message =
      typeof err.message === "string" ? err.message : "Unknown error";
    if (code === 1) {
      if (output_mode === "files_with_matches")
        return { output: "No files found", files: 0 };
      if (output_mode === "count")
        return {
          output: "0\n\nFound 0 total occurrences across 0 files.",
          matches: 0,
          files: 0,
        };
      return { output: "No matches found", matches: 0 };
    }
    throw new Error(`Grep failed: ${message}`);
  }
}
