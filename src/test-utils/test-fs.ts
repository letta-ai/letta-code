
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class TestDirectory {
  public readonly path: string;

  constructor() {
    this.path = mkdtempSync(join(tmpdir(), "letta-test-"));
  }

  createFile(relativePath: string, content: string): string {
    const filePath = join(this.path, relativePath);
    const dir = join(filePath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  createBinaryFile(relativePath: string, buffer: Buffer): string {
    const filePath = join(this.path, relativePath);
    const dir = join(filePath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, buffer);
    return filePath;
  }

  createDir(relativePath: string): string {
    const dirPath = join(this.path, relativePath);
    mkdirSync(dirPath, { recursive: true });
    return dirPath;
  }

  resolve(relativePath: string): string {
    return join(this.path, relativePath);
  }

  cleanup(): void {
    try {
      rmSync(this.path, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to cleanup test directory ${this.path}:`, error);
    }
  }
}

/**
 * Remove a temp directory created by a test. Retries briefly on transient
 * Windows locks and swallows any final error (including Bun's EFAULT on
 * Windows): a leaked temp dir is harmless, but a failed cleanup must never
 * fail a passing test.
 */
export async function removeTestDir(path: string): Promise<void> {
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  } catch {
  }
}
