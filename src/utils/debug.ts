// src/utils/debug.ts
// Simple debug logging utility - only logs when LETTA_DEBUG env var is set
// Optionally logs to a file when LETTA_DEBUG_FILE is set

import { appendFileSync } from "node:fs";
import { format } from "node:util";

/**
 * Check if debug mode is enabled via LETTA_DEBUG env var
 * Set LETTA_DEBUG=1 or LETTA_DEBUG=true to enable debug logging
 */
export function isDebugEnabled(): boolean {
  const debug = process.env.LETTA_DEBUG;
  return debug === "1" || debug === "true";
}

function getDebugFile(): string | null {
  const path = process.env.LETTA_DEBUG_FILE;
  return path && path.trim().length > 0 ? path : null;
}

function writeDebugLine(
  prefix: string,
  message: string,
  args: unknown[],
): void {
  const debugFile = getDebugFile();
  const line = `${format(`[${prefix}] ${message}`, ...args)}\n`;
  if (debugFile) {
    try {
      appendFileSync(debugFile, line, { encoding: "utf8" });
      return;
    } catch {
      // Fall back to console if file write fails
    }
  }
  // Default to console output
  console.log(line.trimEnd());
}

/**
 * Log a debug message (only if LETTA_DEBUG is enabled)
 * @param prefix - A prefix/tag for the log message (e.g., "check-approval")
 * @param message - The message to log
 * @param args - Additional arguments to log
 */
export function debugLog(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  if (isDebugEnabled()) {
    writeDebugLine(prefix, message, args);
  }
}

/**
 * Log a debug warning (only if LETTA_DEBUG is enabled)
 * @param prefix - A prefix/tag for the log message
 * @param message - The message to log
 * @param args - Additional arguments to log
 */
export function debugWarn(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  if (isDebugEnabled()) {
    writeDebugLine(prefix, `WARN: ${message}`, args);
  }
}
