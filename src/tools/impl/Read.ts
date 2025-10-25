import { promises as fs } from "node:fs";
import * as path from "node:path";

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
  const startLine = offset || 0;
  const endLine = limit
    ? Math.min(startLine + limit, lines.length)
    : lines.length;
  const actualStartLine = Math.min(startLine, lines.length);
  const actualEndLine = Math.min(endLine, lines.length);
  const selectedLines = lines.slice(actualStartLine, actualEndLine);
  const maxLineNumber = actualStartLine + selectedLines.length;
  const padding = Math.max(1, maxLineNumber.toString().length);
  return selectedLines
    .map((line, index) => {
      const lineNumber = actualStartLine + index + 1;
      const paddedNumber = lineNumber.toString().padStart(padding);
      return `${paddedNumber}→${line}`;
    })
    .join("\n");
}

export async function read(args: ReadArgs): Promise<ReadResult> {
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
