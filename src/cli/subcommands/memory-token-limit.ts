import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  formatMemoryPolicy,
  LEGACY_MEMORY_POLICY_PATH,
  MEMORY_POLICY_CHANGE_APPROVAL_ENV,
  MEMORY_POLICY_CHANGE_APPROVAL_FILE,
  MEMORY_POLICY_PATH,
  readMemoryPolicyTokenLimit,
} from "@/agent/memory-policy";
import { estimateSystemPromptSize } from "@/utils/system-prompt-size";

const SYSTEM_PROMPT_TOKEN_LIMIT_SETTING = "systemPromptTokenLimit";

interface MemoryConfigInput {
  operation?: string;
  value?: string;
  memoryDir?: string;
  agentMemoryDir?: string;
}

function resolveMemoryDir(input: MemoryConfigInput): string | null {
  const candidate =
    input.memoryDir || process.env.MEMORY_DIR || input.agentMemoryDir;
  return candidate ? resolve(candidate) : null;
}

function runGit(
  memoryDir: string,
  args: string[],
  approvalToken?: string,
): string {
  return execFileSync("git", args, {
    cwd: memoryDir,
    encoding: "utf8",
    env: approvalToken
      ? {
          ...process.env,
          [MEMORY_POLICY_CHANGE_APPROVAL_ENV]: approvalToken,
        }
      : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function runMemoryTokenLimitAction(
  input: MemoryConfigInput,
): Promise<number> {
  const memoryDir = resolveMemoryDir(input);
  if (!memoryDir) {
    console.error(
      "Missing memory dir. Pass --memory-dir, set MEMORY_DIR, or pass --agent.",
    );
    return 64;
  }
  if (!existsSync(memoryDir)) {
    console.error(`Memory directory does not exist: ${memoryDir}`);
    return 64;
  }

  const operation = input.operation ?? "get";
  if (operation === "get") {
    if (input.value !== undefined) {
      console.error("The get operation does not accept a value.");
      return 64;
    }
    try {
      const policy = readMemoryPolicyTokenLimit(memoryDir);
      console.log(
        JSON.stringify(
          {
            key: SYSTEM_PROMPT_TOKEN_LIMIT_SETTING,
            value: policy.limit,
            source: policy.source,
          },
          null,
          2,
        ),
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (operation !== "set") {
    console.error(`Unknown memory token-limit operation: ${operation}`);
    return 64;
  }

  const limit = parsePositiveInteger(input.value);
  if (limit === null) {
    console.error("System prompt token limit must be a positive integer.");
    return 64;
  }

  const estimate = estimateSystemPromptSize(memoryDir);
  if (estimate.total >= limit) {
    console.error(
      `System prompt is approximately ${estimate.total} tokens; the configured limit must be greater than the current estimate.`,
    );
    return 1;
  }

  try {
    runGit(memoryDir, ["rev-parse", "--is-inside-work-tree"]);
    const status = runGit(memoryDir, ["status", "--porcelain"]);
    if (status) {
      console.error(
        "Memory repo has uncommitted changes. Commit, discard, or sync them before changing memory configuration.",
      );
      return 1;
    }

    const policyRelativePath = existsSync(join(memoryDir, MEMORY_POLICY_PATH))
      ? MEMORY_POLICY_PATH
      : existsSync(join(memoryDir, LEGACY_MEMORY_POLICY_PATH))
        ? LEGACY_MEMORY_POLICY_PATH
        : MEMORY_POLICY_PATH;
    const policyPath = join(memoryDir, policyRelativePath);
    const policyExisted = existsSync(policyPath);
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, formatMemoryPolicy(limit), "utf8");
    runGit(memoryDir, ["add", "--", policyRelativePath]);

    const staged = runGit(memoryDir, [
      "diff",
      "--cached",
      "--name-only",
      "--",
      policyRelativePath,
    ]);
    if (!staged) {
      console.log(
        JSON.stringify(
          {
            changed: false,
            key: SYSTEM_PROMPT_TOKEN_LIMIT_SETTING,
            value: limit,
            source: policyRelativePath,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    const approvalToken = randomBytes(32).toString("hex");
    const approvalPath = resolve(
      memoryDir,
      runGit(memoryDir, [
        "rev-parse",
        "--git-path",
        MEMORY_POLICY_CHANGE_APPROVAL_FILE,
      ]),
    );
    writeFileSync(approvalPath, approvalToken, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      try {
        runGit(
          memoryDir,
          [
            "commit",
            "-m",
            `config: set system prompt token limit to ${limit}`,
            "--",
            policyRelativePath,
          ],
          approvalToken,
        );
      } catch (error) {
        try {
          runGit(memoryDir, ["reset", "HEAD", "--", policyRelativePath]);
          if (policyExisted) {
            runGit(memoryDir, ["checkout", "--", policyRelativePath]);
          } else {
            rmSync(policyPath, { force: true });
          }
        } catch {
          // Preserve the original commit error; cleanup is best-effort.
        }
        throw error;
      }
    } finally {
      rmSync(approvalPath, { force: true });
    }
    const commit = runGit(memoryDir, ["rev-parse", "HEAD"]);
    console.log(
      JSON.stringify(
        {
          changed: true,
          commit,
          key: SYSTEM_PROMPT_TOKEN_LIMIT_SETTING,
          value: limit,
          source: policyRelativePath,
          sync: "Commit created; push or allow the harness to sync memory.",
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
