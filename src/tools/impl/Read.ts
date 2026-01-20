import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resizeImageIfNeeded } from "../../cli/helpers/imageResize.js";
import { queueToolImage } from "../../cli/helpers/toolImageRegistry.js";
import { getToolExecutionContext } from "../toolContext.js";
import { OVERFLOW_CONFIG, writeOverflowFile } from "./overflow.js";
import { LIMITS } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

// Supported image extensions (lowercase)
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

/**
 * Check if a file path is an image based on extension.
 */
function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Get MIME type from file extension.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return mimeTypes[ext] || "image/png";
}

/**
 * Read an image file, resize if needed, and queue for display.
 * Returns a placeholder message - actual image is sent in the next user message.
 */
async function readImageFile(filePath: string): Promise<ReadResult> {
  const buffer = await fs.readFile(filePath);
  const inputMimeType = getMimeType(filePath);
  const resized = await resizeImageIfNeeded(buffer, inputMimeType);

  // Get tool call ID from execution context
  const context = getToolExecutionContext();
  const toolCallId = context?.toolCallId || "unknown";

  // Queue for next turn
  queueToolImage({
    toolCallId,
    filePath,
    data: resized.data,
    mediaType: resized.mediaType,
    width: resized.width,
    height: resized.height,
  });

  const resizeNote = resized.resized
    ? ` (resized to ${resized.width}x${resized.height})`
    : ` (${resized.width}x${resized.height})`;

  return {
    content: `[Image: ${filePath}${resizeNote} - queued for display]`,
  };
}

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

      // Count control characters (excluding whitespace)
      // This catches files that are mostly control characters but lack null bytes
      const text = buffer.slice(0, bytesRead).toString("utf-8");
      let controlCharCount = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        // Allow tab(9), newline(10), carriage return(13)
        if (code < 9 || (code > 13 && code < 32)) {
          controlCharCount++;
        }
      }
      return controlCharCount / text.length > 0.3;
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
  workingDirectory?: string,
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

  // Write to overflow file if content was truncated and overflow is enabled
  let overflowPath: string | undefined;
  if (
    (wasTruncatedByLineCount || linesWereTruncatedInLength) &&
    OVERFLOW_CONFIG.ENABLED &&
    workingDirectory
  ) {
    try {
      overflowPath = writeOverflowFile(content, workingDirectory, "Read");
    } catch (error) {
      // Silently fail if overflow file creation fails
      console.error("Failed to write overflow file:", error);
    }
  }

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

  if (overflowPath) {
    notices.push(`\n\n[Full file content written to: ${overflowPath}]`);
  }

  if (notices.length > 0) {
    result += notices.join("");
  }

  return result;
}

export async function read(args: ReadArgs): Promise<ReadResult> {
  validateRequiredParams(args, ["file_path"], "Read");
  const { file_path, offset, limit } = args;
  const userCwd = process.env.USER_CWD || process.cwd();
  const resolvedPath = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(userCwd, file_path);
  try {
    const stats = await fs.stat(resolvedPath);
    if (stats.isDirectory())
      throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (stats.size > maxSize)
      throw new Error(
        `File too large: ${stats.size} bytes (max ${maxSize} bytes)`,
      );

    // Handle image files specially - read, resize, and queue for display
    if (isImageFile(resolvedPath)) {
      return await readImageFile(resolvedPath);
    }

    if (await isBinaryFile(resolvedPath))
      throw new Error(`Cannot read binary file: ${resolvedPath}`);
    const content = await fs.readFile(resolvedPath, "utf-8");
    if (content.trim() === "") {
      return {
        content: `<system-reminder>\nThe file ${resolvedPath} exists but has empty contents.\n</system-reminder>`,
      };
    }
    const formattedContent = formatWithLineNumbers(
      content,
      offset,
      limit,
      userCwd,
    );
    return { content: formattedContent };
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
    else throw new Error(`Failed to read file: ${String(err)}`);
  }
}
