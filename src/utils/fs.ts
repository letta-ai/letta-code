/**
 * File system utilities using Node.js APIs
 * Compatible with both Node.js and Bun
 */

import {
  existsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Read a file and return its contents as text
 */
export async function readFile(path: string): Promise<string> {
  return fsReadFileSync(path, { encoding: "utf-8" });
}

/**
 * Write content to a file, creating parent directories if needed
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  fsWriteFileSync(path, content, { encoding: "utf-8", flush: true });
}

/**
 * Check if a file exists
 */
export function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * Create a directory, including parent directories
 */
export async function mkdir(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  mkdirSync(path, options);
}
