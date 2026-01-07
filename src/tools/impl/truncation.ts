/**
 * Centralized truncation utilities for tool outputs.
 * Implements limits similar to Claude Code to prevent excessive token usage.
 * When outputs exceed limits, full content can be written to overflow files.
 */

import {
	OVERFLOW_CONFIG,
	writeOverflowFile,
} from "./overflow.js";

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
 * Options for truncation with overflow support
 */
export interface TruncationOptions {
	/** Working directory for overflow file creation */
	workingDirectory?: string;
	/** Tool name for overflow file naming */
	toolName?: string;
	/** Whether to use middle truncation (keep beginning and end) */
	useMiddleTruncation?: boolean;
}

/**
 * Truncates text to a maximum character count.
 * Adds a truncation notice when content exceeds limit.
 * Optionally writes full output to an overflow file.
 */
export function truncateByChars(
	text: string,
	maxChars: number,
	toolName: string = "output",
	options?: TruncationOptions,
): { content: string; wasTruncated: boolean; overflowPath?: string } {
	if (text.length <= maxChars) {
		return { content: text, wasTruncated: false };
	}

	// Determine if we should use middle truncation
	const useMiddleTruncation =
		options?.useMiddleTruncation ?? OVERFLOW_CONFIG.MIDDLE_TRUNCATE;

	// Write to overflow file if enabled and working directory provided
	let overflowPath: string | undefined;
	if (OVERFLOW_CONFIG.ENABLED && options?.workingDirectory) {
		try {
			overflowPath = writeOverflowFile(
				text,
				options.workingDirectory,
				options.toolName ?? toolName,
			);
		} catch (error) {
			// Silently fail if overflow file creation fails
			console.error("Failed to write overflow file:", error);
		}
	}

	let truncated: string;
	if (useMiddleTruncation) {
		// Middle truncation: keep beginning and end
		const halfMax = Math.floor(maxChars / 2);
		const beginning = text.slice(0, halfMax);
		const end = text.slice(-halfMax);
		const omittedChars = text.length - maxChars;
		const middleNotice = `\n... [${omittedChars.toLocaleString()} characters omitted] ...\n`;
		truncated = beginning + middleNotice + end;
	} else {
		// Post truncation: keep beginning only
		truncated = text.slice(0, maxChars);
	}

	const noticeLines = [
		`[Output truncated: showing ${maxChars.toLocaleString()} of ${text.length.toLocaleString()} characters.]`,
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

/**
 * Truncates text by line count.
 * Optionally enforces max characters per line.
 * Optionally writes full output to an overflow file.
 */
export function truncateByLines(
	text: string,
	maxLines: number,
	maxCharsPerLine?: number,
	toolName: string = "output",
	options?: TruncationOptions,
): {
	content: string;
	wasTruncated: boolean;
	originalLineCount: number;
	linesShown: number;
	overflowPath?: string;
} {
	const lines = text.split("\n");
	const originalLineCount = lines.length;

	// Determine if we should use middle truncation
	const useMiddleTruncation =
		options?.useMiddleTruncation ?? OVERFLOW_CONFIG.MIDDLE_TRUNCATE;

	let selectedLines: string[];
	if (useMiddleTruncation && lines.length > maxLines) {
		// Middle truncation: keep beginning and end lines
		const halfMax = Math.floor(maxLines / 2);
		const beginning = lines.slice(0, halfMax);
		const end = lines.slice(-halfMax);
		const omittedLines = lines.length - maxLines;
		selectedLines = [
			...beginning,
			`... [${omittedLines.toLocaleString()} lines omitted] ...`,
			...end,
		];
	} else {
		// Post truncation: keep beginning lines only
		selectedLines = lines.slice(0, maxLines);
	}

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

	// Write to overflow file if enabled and working directory provided
	let overflowPath: string | undefined;
	if (wasTruncated && OVERFLOW_CONFIG.ENABLED && options?.workingDirectory) {
		try {
			overflowPath = writeOverflowFile(
				text,
				options.workingDirectory,
				options.toolName ?? toolName,
			);
		} catch (error) {
			// Silently fail if overflow file creation fails
			console.error("Failed to write overflow file:", error);
		}
	}

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

		if (overflowPath) {
			notices.push(`[Full output written to: ${overflowPath}]`);
		}

		content += `\n\n${notices.join(" ")}`;
	}

	return {
		content,
		wasTruncated,
		originalLineCount,
		linesShown: selectedLines.length,
		overflowPath,
	};
}

/**
 * Truncates an array of items (file paths, directory entries, etc.)
 * Optionally writes full output to an overflow file.
 */
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

	// Determine if we should use middle truncation
	const useMiddleTruncation =
		options?.useMiddleTruncation ?? OVERFLOW_CONFIG.MIDDLE_TRUNCATE;

	let selectedItems: T[];
	if (useMiddleTruncation) {
		// Middle truncation: keep beginning and end
		const halfMax = Math.floor(maxItems / 2);
		const beginning = items.slice(0, halfMax);
		const end = items.slice(-halfMax);
		// Note: We can't insert a marker in the middle of a typed array,
		// so we'll just show beginning and end
		selectedItems = [...beginning, ...end];
	} else {
		// Post truncation: keep beginning only
		selectedItems = items.slice(0, maxItems);
	}

	// Write to overflow file if enabled and working directory provided
	let overflowPath: string | undefined;
	if (OVERFLOW_CONFIG.ENABLED && options?.workingDirectory) {
		try {
			const fullContent = formatter(items);
			overflowPath = writeOverflowFile(
				fullContent,
				options.workingDirectory,
				options.toolName ?? toolName,
			);
		} catch (error) {
			// Silently fail if overflow file creation fails
			console.error("Failed to write overflow file:", error);
		}
	}

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

/**
 * Format bytes for human-readable display
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
