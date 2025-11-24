/**
 * File state tracking for conflict detection
 *
 * This module tracks when files are read and modified to enable
 * optimistic concurrency control for parallel subagent execution.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

interface FileState {
  /** File path */
  path: string;
  /** Hash of file contents when last read */
  hash: string;
  /** Timestamp when file was last read */
  readAt: Date;
  /** Agent ID that read this file */
  agentId: string;
}

// Use globalThis to ensure singleton across bundle
const TRACKER_KEY = Symbol.for("@letta/fileTracker");

type GlobalWithTracker = typeof globalThis & {
  [key: symbol]: Map<string, Map<string, FileState>>;
};

function getTracker(): Map<string, Map<string, FileState>> {
  const global = globalThis as GlobalWithTracker;
  if (!global[TRACKER_KEY]) {
    // Map<agentId, Map<filePath, FileState>>
    global[TRACKER_KEY] = new Map();
  }
  return global[TRACKER_KEY];
}

/**
 * Compute hash of file contents
 */
async function computeFileHash(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    // File doesn't exist or can't be read
    return "";
  }
}

/**
 * Record that an agent has read a file
 */
export async function trackFileRead(
  agentId: string,
  filePath: string,
): Promise<void> {
  const tracker = getTracker();

  // Get or create agent's file map
  let agentFiles = tracker.get(agentId);
  if (!agentFiles) {
    agentFiles = new Map();
    tracker.set(agentId, agentFiles);
  }

  // Compute current file hash
  const hash = await computeFileHash(filePath);

  // Record file state
  agentFiles.set(filePath, {
    path: filePath,
    hash,
    readAt: new Date(),
    agentId,
  });
}

/**
 * Check if a file has been modified since the agent last read it
 */
export async function hasFileChanged(
  agentId: string,
  filePath: string,
): Promise<boolean> {
  const tracker = getTracker();
  const agentFiles = tracker.get(agentId);

  if (!agentFiles) {
    // Agent hasn't read any files yet
    return false;
  }

  const fileState = agentFiles.get(filePath);
  if (!fileState) {
    // Agent hasn't read this specific file
    return false;
  }

  // Compute current hash and compare
  const currentHash = await computeFileHash(filePath);
  return currentHash !== fileState.hash;
}

/**
 * Get file state for an agent and file
 */
export function getFileState(
  agentId: string,
  filePath: string,
): FileState | undefined {
  const tracker = getTracker();
  const agentFiles = tracker.get(agentId);
  return agentFiles?.get(filePath);
}

/**
 * Clear file state for an agent
 */
export function clearAgentFileState(agentId: string): void {
  const tracker = getTracker();
  tracker.delete(agentId);
}

/**
 * Clear all file tracking state
 */
export function clearAllFileState(): void {
  const tracker = getTracker();
  tracker.clear();
}

/**
 * Get all tracked files for an agent
 */
export function getAgentTrackedFiles(agentId: string): string[] {
  const tracker = getTracker();
  const agentFiles = tracker.get(agentId);
  return agentFiles ? Array.from(agentFiles.keys()) : [];
}

/**
 * Update file hash after successful write
 */
export async function updateFileHash(
  agentId: string,
  filePath: string,
): Promise<void> {
  const tracker = getTracker();
  const agentFiles = tracker.get(agentId);

  if (!agentFiles) {
    return;
  }

  const fileState = agentFiles.get(filePath);
  if (!fileState) {
    return;
  }

  // Update hash to current state
  const newHash = await computeFileHash(filePath);
  agentFiles.set(filePath, {
    ...fileState,
    hash: newHash,
    readAt: new Date(),
  });
}
