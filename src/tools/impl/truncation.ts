/**
 * Centralized truncation utilities for tool outputs.
 * Implements limits similar to Claude Code to prevent excessive token usage.
 */

// Limits based on Claude Code's proven production values
export const LIMITS = {
  // Command output limits
  BASH_OUTPUT_CHARS: 30_000, // 30K characters for bash/shell output

  // File reading limits
  READ_MAX_LINES: 2_000, // Max lines per file read
  READ_MAX_CHARS_PER_LINE: 2_000, // Max characters per line

  // Search/discovery limits
  GREP_OUTPUT_CHARS: 10_000, // Max characters for grep results
  GLOB_MAX_FILES: 2_000, // Max number of file paths
  LS_MAX_ENTRIES: 1_000, // Max directory entries
} as const;

/**
 * Truncates text to a maximum character count.
 * Adds a truncation notice when content exceeds limit.
 */
export function truncateByChars(
  text: string,
  maxChars: number,
  _toolName: string = "output",
): { content: string; wasTruncated: boolean } {
  if (text.length <= maxChars) {
    return { content: text, wasTruncated: false };
  }

  const truncated = text.slice(0, maxChars);
  const notice = `\n\n[Output truncated after ${maxChars.toLocaleString()} characters: exceeded limit.]`;

  return {
    content: truncated + notice,
    wasTruncated: true,
  };
}

/**
 * Truncates text by line count.
 * Optionally enforces max characters per line.
 */
export function truncateByLines(
  text: string,
  maxLines: number,
  maxCharsPerLine?: number,
  _toolName: string = "output",
): {
  content: string;
  wasTruncated: boolean;
  originalLineCount: number;
  linesShown: number;
} {
  const lines = text.split("\n");
  const originalLineCount = lines.length;

  let selectedLines = lines.slice(0, maxLines);
  let linesWereTruncatedInLength = false;

  // Apply per-line character limit if specified
  if (maxCharsPerLine !== undefined) {
    selectedLines = selectedLines.map((line) => {
      if (line.length > maxCharsPerLine) {
        linesWereTruncatedInLength = true;
        return `${line.slice(0, maxCharsPerLine)}... [line truncated]`;
      }
      return line;
    });
  }

  const wasTruncated = lines.length > maxLines || linesWereTruncatedInLength;
  let content = selectedLines.join("\n");

  if (wasTruncated) {
    const notices: string[] = [];

    if (lines.length > maxLines) {
      notices.push(
        `[Output truncated: showing ${maxLines.toLocaleString()} of ${originalLineCount.toLocaleString()} lines.]`,
      );
    }

    if (linesWereTruncatedInLength && maxCharsPerLine) {
      notices.push(
        `[Some lines exceeded ${maxCharsPerLine.toLocaleString()} characters and were truncated.]`,
      );
    }

    content += `\n\n${notices.join(" ")}`;
  }

  return {
    content,
    wasTruncated,
    originalLineCount,
    linesShown: selectedLines.length,
  };
}

/**
 * Truncates an array of items (file paths, directory entries, etc.)
 */
export function truncateArray<T>(
  items: T[],
  maxItems: number,
  formatter: (items: T[]) => string,
  itemType: string = "items",
): { content: string; wasTruncated: boolean } {
  if (items.length <= maxItems) {
    return { content: formatter(items), wasTruncated: false };
  }

  const truncatedItems = items.slice(0, maxItems);
  const content = formatter(truncatedItems);
  const notice = `\n\n[Output truncated: showing ${maxItems.toLocaleString()} of ${items.length.toLocaleString()} ${itemType}.]`;

  return {
    content: content + notice,
    wasTruncated: true,
  };
}

/**
 * Format bytes for human-readable display
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
