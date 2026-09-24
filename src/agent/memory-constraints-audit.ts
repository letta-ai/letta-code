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

function memoryLayoutPolicy(
  memoryDir: string,
  revision: string,
): MemoryLayoutPolicy {
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
        ["rev-list", "-n", "1", revision, "--", "MEMORY.md"],
        { cwd: memoryDir, encoding: "utf8" },
      ).trim();
      return v2Started ? "root-marker" : "legacy-only";
    }
  } catch {
    /* Repositories created outside the harness have no persistent policy. */
  }
  return spawnSync("git", ["cat-file", "-e", `${revision}:MEMORY.md`], {
    cwd: memoryDir,
    stdio: "ignore",
  }).status === 0
    ? "root-marker"
    : "legacy-only";
}

/** Validate one committed MemFS tree without changing its index or working tree. */
export function validateMemoryConstraintsRevision(
  memoryDir: string,
  revision: string,
): MemoryConstraintsValidationResult {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-memory-audit-"));
  const indexPath = join(tempDir, "index");
  const validatorPath = join(tempDir, "validator.cjs");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };

  try {
    execFileSync("git", ["read-tree", revision], {
      cwd: memoryDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const layoutPolicy = memoryLayoutPolicy(memoryDir, revision);
    writeFileSync(validatorPath, MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT, "utf8");
    const result = spawnSync(
      "node",
      [validatorPath, "--layout", layoutPolicy, "--audit", "--base", revision],
      {
        cwd: memoryDir,
        encoding: "utf8",
        env,
      },
    );
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

/** Validate HEAD without changing its index or working tree. */
export function validateMemoryConstraintsHead(
  memoryDir: string,
): MemoryConstraintsValidationResult {
  return validateMemoryConstraintsRevision(memoryDir, "HEAD");
}

export function invalidPendingMemory(
  memoryDir: string,
  localOnly: boolean,
): InvalidPendingMemory | null {
  const revisions = execFileSync(
    "git",
    ["rev-list", "--reverse", "@{u}..HEAD"],
    { cwd: memoryDir, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const revision of revisions) {
    const validation = validateMemoryConstraintsRevision(memoryDir, revision);
    if (!validation.valid)
      return {
        status: "invalid",
        summary: `Commit ${revision.slice(0, 12)} fails memory validation:\n${validation.output}`,
        memoryDir,
        localOnly,
      };
  }
  return null;
}
