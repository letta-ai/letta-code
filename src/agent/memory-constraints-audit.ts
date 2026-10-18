import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT } from "./memory-constraints";

export interface MemoryConstraintsValidationResult {
  valid: boolean;
  output: string;
}

export interface InvalidPendingMemory {
  status: "invalid";
  summary: string;
  memoryDir: string;
  localOnly: boolean;
}

type MemoryLayoutPolicy = "legacy-only" | "root-marker" | "shared-memory";

function memoryLayoutPolicy(memoryDir: string): MemoryLayoutPolicy {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: memoryDir,
      encoding: "utf8",
    }).trim();
    const policy = readFileSync(
      resolve(memoryDir, commonDir, "letta-memory-layout-policy"),
      "utf8",
    ).trim();
    if (policy === "legacy-only" || policy === "shared-memory") return policy;
    if (policy === "root-marker") {
      const v2Started = execFileSync(
        "git",
        ["rev-list", "-n", "1", "HEAD", "--", "MEMORY.md"],
        { cwd: memoryDir, encoding: "utf8" },
      ).trim();
      return v2Started ? "root-marker" : "legacy-only";
    }
  } catch {
    /* Repositories created outside the harness have no persistent policy. */
  }
  return spawnSync("git", ["cat-file", "-e", "HEAD:MEMORY.md"], {
    cwd: memoryDir,
    stdio: "ignore",
  }).status === 0
    ? "root-marker"
    : "legacy-only";
}

/** Validate the committed MemFS tree without changing its index or working tree. */
export function validateMemoryConstraintsHead(
  memoryDir: string,
): MemoryConstraintsValidationResult {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-memory-audit-"));
  const indexPath = join(tempDir, "index");
  const validatorPath = join(tempDir, "validator.cjs");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };

  try {
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: memoryDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const layoutPolicy = memoryLayoutPolicy(memoryDir);
    writeFileSync(validatorPath, MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT, "utf8");
    // Run the validator with this process's own runtime, like the pre-commit
    // hook does. Desktop installs ship no system `node`, so a PATH lookup fails
    // and every audit would report invalid memory.
    const result = spawnSync(
      process.execPath,
      [validatorPath, "--layout", layoutPolicy, "--audit"],
      {
        cwd: memoryDir,
        encoding: "utf8",
        env: process.versions.electron
          ? { ...env, ELECTRON_RUN_AS_NODE: "1" }
          : env,
      },
    );
    if (result.error) {
      return {
        valid: false,
        output: `Could not run the memory validator: ${result.error.message}`,
      };
    }
    return {
      valid: result.status === 0,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    };
  } catch (error) {
    return {
      valid: false,
      output: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Validate the tree post-turn sync would publish. Hosted MemFS validates only
 * the pushed tip, and the runtime loads only the head of main, so intermediate
 * commits are not checked.
 */
export function invalidPendingMemory(
  memoryDir: string,
  localOnly: boolean,
): InvalidPendingMemory | null {
  const validation = validateMemoryConstraintsHead(memoryDir);
  if (validation.valid) return null;
  return {
    status: "invalid",
    summary: `Committed memory fails validation:\n${validation.output}`,
    memoryDir,
    localOnly,
  };
}
