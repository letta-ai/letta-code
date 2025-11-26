import { promises as fs } from "node:fs";
import * as path from "node:path";
import { LIMITS } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

interface ReadArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}
interface ReadResult {
  content: string;
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const fd = await fs.open(filePath, "r");
    try {
      const stats = await fd.stat();
      const bufferSize = Math.min(8192, stats.size);
      if (bufferSize === 0) return false;
      const buffer = Buffer.alloc(bufferSize);
      const { bytesRead } = await fd.read(buffer, 0, bufferSize, 0);
      if (bytesRead === 0) return false;

      // Check for null bytes (definite binary indicator)
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }

      // Try to decode as UTF-8 and check if valid
      try {
        const text = buffer.slice(0, bytesRead).toString("utf-8");
        // Check for replacement characters (indicates invalid UTF-8)
        if (text.includes("\uFFFD")) return true;

        // Count control characters (excluding whitespace)
        let controlCharCount = 0;
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          // Allow tab(9), newline(10), carriage return(13)
          if (code < 9 || (code > 13 && code < 32)) {
            controlCharCount++;
          }
        }
        return controlCharCount / text.length > 0.3;
      } catch {
        // Invalid UTF-8 = binary
        return true;
      }
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

function formatWithLineNumbers(
  content: string,
  offset?: number,
  limit?: number,
): string {
  const lines = content.split("\n");
  const originalLineCount = lines.length;
  const startLine = offset || 0;

  // Apply default limit if not specified (Claude Code: 2000 lines)
  const effectiveLimit = limit ?? LIMITS.READ_MAX_LINES;
  const endLine = Math.min(startLine + effectiveLimit, lines.length);
  const actualStartLine = Math.min(startLine, lines.length);
  const actualEndLine = Math.min(endLine, lines.length);
  const selectedLines = lines.slice(actualStartLine, actualEndLine);

  // Apply per-line character limit (Claude Code: 2000 chars/line)
  let linesWereTruncatedInLength = false;
  const formattedLines = selectedLines.map((line, index) => {
    const lineNumber = actualStartLine + index + 1;
    const maxLineNumber = actualStartLine + selectedLines.length;
    const padding = Math.max(1, maxLineNumber.toString().length);
    const paddedNumber = lineNumber.toString().padStart(padding);

    // Truncate long lines
    if (line.length > LIMITS.READ_MAX_CHARS_PER_LINE) {
      linesWereTruncatedInLength = true;
      const truncated = line.slice(0, LIMITS.READ_MAX_CHARS_PER_LINE);
      return `${paddedNumber}→${truncated}... [line truncated]`;
    }

    return `${paddedNumber}→${line}`;
  });

  let result = formattedLines.join("\n");

  // Add truncation notices if applicable
  const notices: string[] = [];
  const wasTruncatedByLineCount = actualEndLine < originalLineCount;

  if (wasTruncatedByLineCount && !limit) {
    // Only show this notice if user didn't explicitly set a limit
    notices.push(
      `\n\n[File truncated: showing lines ${actualStartLine + 1}-${actualEndLine} of ${originalLineCount} total lines. Use offset and limit parameters to read other sections.]`,
    );
  }

  if (linesWereTruncatedInLength) {
    notices.push(
      `\n\n[Some lines exceeded ${LIMITS.READ_MAX_CHARS_PER_LINE.toLocaleString()} characters and were truncated.]`,
    );
  }

  if (notices.length > 0) {
    result += notices.join("");
  }

  return result;
}

export async function read(args: ReadArgs): Promise<ReadResult> {
  validateRequiredParams(args, ["file_path"], "Read");
  const { file_path, offset, limit } = args;
  if (!path.isAbsolute(file_path))
    throw new Error(`File path must be absolute, got: ${file_path}`);
  try {
    const stats = await fs.stat(file_path);
    if (stats.isDirectory())
      throw new Error(`Path is a directory, not a file: ${file_path}`);
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (stats.size > maxSize)
      throw new Error(
        `File too large: ${stats.size} bytes (max ${maxSize} bytes)`,
      );
    if (await isBinaryFile(file_path))
      throw new Error(`Cannot read binary file: ${file_path}`);
    const content = await fs.readFile(file_path, "utf-8");
    const formattedContent = formatWithLineNumbers(content, offset, limit);

    return { content: formattedContent };
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
    else throw new Error(`Failed to read file: ${String(err)}`);
  }
}
