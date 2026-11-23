import { debugLog } from "@/utils/debug.js";
import { OVERFLOW_CONFIG, writeOverflowFile } from "./overflow.js";

export const LIMITS = {
  BASH_OUTPUT_CHARS: 30_000,
  BASH_FAILURE_OUTPUT_CHARS: 10_000,
  TASK_OUTPUT_CHARS: 30_000,
  HOOK_OUTPUT_CHARS: 10_000,
  OVERFLOW_PREVIEW_CHARS: 2_000,
  BASH_NOTIFICATION_CHARS: 10_000,

  READ_MAX_LINES: 2_000,
  READ_MAX_CHARS_PER_LINE: 2_000,
  READ_OUTPUT_CHARS: 30_000,

  GREP_OUTPUT_CHARS: 10_000,
  GLOB_MAX_FILES: 2_000,
  LS_MAX_ENTRIES: 1_000,
  MEMORY_MAX_ENTRIES: 10,

  TOOL_RETURN_MAX_CHARS: 32_000,
} as const;

export interface TruncationOptions {
  workingDirectory?: string;
  useMiddleTruncation?: boolean;
  previewChars?: number;
  secrets?: Readonly<Record<string, string>>;
}

function writeOverflow(
  getContent: () => string,
  toolName: string,
  options?: TruncationOptions,
): string | undefined {
  if (!OVERFLOW_CONFIG.ENABLED || !options?.workingDirectory) {
    return undefined;
  }
  try {
    return writeOverflowFile(
      getContent(),
      options.workingDirectory,
      toolName,
      options.secrets,
    );
  } catch (error) {
    debugLog("truncation", "Failed to write overflow file: %O", error);
    return undefined;
  }
}

export function truncateByChars(
  text: string,
  maxChars: number,
  toolName: string = "output",
  options?: TruncationOptions,
): { content: string; wasTruncated: boolean; overflowPath?: string } {
  if (text.length <= maxChars) {
    return { content: text, wasTruncated: false };
  }

  const overflowPath = writeOverflow(() => text, toolName, options);

  const filePreviewChars = overflowPath ? options?.previewChars : undefined;
  const shownChars = Math.min(maxChars, filePreviewChars ?? maxChars);
  const useMiddleTruncation =
    filePreviewChars === undefined &&
    (options?.useMiddleTruncation ?? OVERFLOW_CONFIG.MIDDLE_TRUNCATE);

  let truncated: string;
  if (useMiddleTruncation) {
    const halfMax = Math.floor(shownChars / 2);
    const beginning = text.slice(0, halfMax);
    const end = text.slice(-halfMax);
    const omittedChars = text.length - shownChars;
    const middleNotice = `\n... [${omittedChars.toLocaleString()} characters omitted] ...\n`;
    truncated = beginning + middleNotice + end;
  } else {
    truncated = text.slice(0, shownChars);
  }

  const noticeLines = [
    `[Output truncated: showing ${shownChars.toLocaleString()} of ${text.length.toLocaleString()} characters.]`,
  ];

  if (overflowPath) {
    noticeLines.push(`[Full output written to: ${overflowPath}]`);
  }

  const notice = `\n\n${noticeLines.join("\n")}`;

  return {
    content: truncated + notice,
    wasTruncated: true,
    overflowPath,
  };
}

export function truncateArray<T>(
  items: T[],
  maxItems: number,
  formatter: (items: T[]) => string,
  itemType: string = "items",
  toolName: string = "output",
  options?: TruncationOptions,
): { content: string; wasTruncated: boolean; overflowPath?: string } {
  if (items.length <= maxItems) {
    return { content: formatter(items), wasTruncated: false };
  }

  const useMiddleTruncation =
    options?.useMiddleTruncation ?? OVERFLOW_CONFIG.MIDDLE_TRUNCATE;

  let selectedItems: T[];
  if (useMiddleTruncation) {
    const halfMax = Math.floor(maxItems / 2);
    const beginning = items.slice(0, halfMax);
    const end = items.slice(-halfMax);
    selectedItems = [...beginning, ...end];
  } else {
    selectedItems = items.slice(0, maxItems);
  }

  const overflowPath = writeOverflow(() => formatter(items), toolName, options);

  const content = formatter(selectedItems);
  const noticeLines = [
    `[Output truncated: showing ${maxItems.toLocaleString()} of ${items.length.toLocaleString()} ${itemType}.]`,
  ];

  if (useMiddleTruncation) {
    const omitted = items.length - maxItems;
    noticeLines.push(
      `[${omitted.toLocaleString()} ${itemType} omitted from middle.]`,
    );
  }

  if (overflowPath) {
    noticeLines.push(`[Full output written to: ${overflowPath}]`);
  }

  const notice = `\n\n${noticeLines.join("\n")}`;

  return {
    content: content + notice,
    wasTruncated: true,
    overflowPath,
  };
}
