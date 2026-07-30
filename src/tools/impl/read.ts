import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { debugLog } from "@/utils/debug.js";
import { expandFilePath } from "@/utils/file-path";
import { resizeImageIfNeeded } from "@/utils/image-resize.js";
import { getUtf16Bom, readUtf8TextStrict } from "@/utils/text-files";
import { OVERFLOW_CONFIG, writeOverflowFile } from "./overflow.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

interface ReadArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

// Tool return content types - either a string or array of content parts
export type ToolReturnContent = string | Array<TextContent | ImageContent>;

interface ReadResult {
  content: ToolReturnContent;
}

// Supported image extensions
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
]);

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function getMediaType(ext: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/png", // Convert BMP to PNG
    ".heic": "image/heic",
    ".heif": "image/heif",
  };
  return types[ext] || "image/png";
}

async function readImageFile(
  filePath: string,
): Promise<Array<TextContent | ImageContent>> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = getMediaType(ext);

  // Use shared image resize utility
  let result: Awaited<ReturnType<typeof resizeImageIfNeeded>>;
  try {
    result = await resizeImageIfNeeded(buffer, mediaType);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read image file: ${filePath} (${detail})`);
  }

  return [
    {
      type: "text",
      text: `[Image: ${path.basename(filePath)}${result.resized ? " (resized to fit API limits)" : ""}]`,
    },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: result.mediaType,
        data: result.data,
      },
    },
  ];
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
      if (getUtf16Bom(buffer.subarray(0, bytesRead))) return false;

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

  // Apply total-character clamp (Claude Code applies the same 30K class of
  // limit as bash/task output). Line and per-line caps alone allow up to
  // ~4M chars (2,000 lines x 2,000 chars) in a single read.
  let wasTruncatedByTotalChars = false;
  if (result.length > LIMITS.READ_OUTPUT_CHARS) {
    wasTruncatedByTotalChars = true;
    // Overflow is written below from the raw file content, so skip the
    // overflow write here (no workingDirectory passed).
    result = truncateByChars(result, LIMITS.READ_OUTPUT_CHARS, "Read").content;
  }

  // Add truncation notices if applicable
  const notices: string[] = [];
  const wasTruncatedByLineCount = actualEndLine < originalLineCount;

  // Write to overflow file if content was truncated and overflow is enabled
  let overflowPath: string | undefined;
  if (
    (wasTruncatedByLineCount ||
      linesWereTruncatedInLength ||
      wasTruncatedByTotalChars) &&
    OVERFLOW_CONFIG.ENABLED &&
    workingDirectory
  ) {
    try {
      overflowPath = writeOverflowFile(content, workingDirectory, "Read");
    } catch (error) {
      // Silently fail if overflow file creation fails
      debugLog("read", "Failed to write overflow file: %O", error);
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

  if (wasTruncatedByTotalChars) {
    notices.push(
      `\n\n[Use offset and limit parameters to read the file in smaller sections.]`,
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
  const userCwd = getCurrentWorkingDirectory();
  const resolvedPath = expandFilePath(file_path, userCwd);
  try {
    const stats = await fs.stat(resolvedPath);
    if (stats.isDirectory())
      throw new Error(`Path is a directory, not a file: ${resolvedPath}`);

    // Check if this is an image file
    if (isImageFile(resolvedPath)) {
      // Images have a higher size limit (20MB raw, will be resized if needed)
      const maxImageSize = 20 * 1024 * 1024;
      if (stats.size > maxImageSize) {
        throw new Error(
          `Image file too large: ${stats.size} bytes (max ${maxImageSize} bytes)`,
        );
      }
      const imageContent = await readImageFile(resolvedPath);
      return { content: imageContent };
    }

    // Regular text file handling
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (stats.size > maxSize)
      throw new Error(
        `File too large: ${stats.size} bytes (max ${maxSize} bytes)`,
      );
    if (await isBinaryFile(resolvedPath))
      throw new Error(`Cannot read binary file: ${resolvedPath}`);
    const content = await readUtf8TextStrict(resolvedPath);
    if (content.trim() === "") {
      return {
        content: `${SYSTEM_REMINDER_OPEN}\nThe file ${resolvedPath} exists but has empty contents.\n${SYSTEM_REMINDER_CLOSE}`,
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
