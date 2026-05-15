import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMemoryRepoDir,
  getScopedMemoryRepoDir,
  isGitRepo,
} from "../../agent/memoryGit";
import { getLocalBackendMemoryFilesystemRoot } from "../../backend/local/paths";

function withTemporaryEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => T,
): T {
  const original = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("memoryGit local backend scoping", () => {
  test("uses the local backend memfs repo when local backend is enabled", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "letta-local-memfs-"));
    const agentId = "agent-local-scope-test";

    try {
      withTemporaryEnv(
        {
          LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
          LETTA_LOCAL_BACKEND_DIR: storageDir,
        },
        () => {
          expect(getScopedMemoryRepoDir(agentId)).toBe(
            getLocalBackendMemoryFilesystemRoot(agentId, storageDir),
          );
          expect(getScopedMemoryRepoDir(agentId)).not.toBe(
            getMemoryRepoDir(agentId),
          );

          const scopedDir = getScopedMemoryRepoDir(agentId);
          mkdirSync(scopedDir, { recursive: true });
          Bun.spawnSync(["git", "init"], { cwd: scopedDir });
          expect(existsSync(join(scopedDir, ".git"))).toBe(true);
          expect(isGitRepo(agentId)).toBe(true);
        },
      );
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
