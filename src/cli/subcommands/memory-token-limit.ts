import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  formatMemoryTokenLimit,
  MEMORY_TOKEN_LIMIT_POLICY_PATH,
  MEMORY_TOKEN_LIMIT_UPDATE_ENV,
  readMemoryTokenLimit,
} from "@/agent/memory-token-limit";
import { estimateSystemPromptSize } from "@/utils/system-prompt-size";

const USAGE_EXIT = 64;
const IO_EXIT = 65;

interface MemoryTokenLimitInput {
  operation?: string;
  value?: string;
  memoryDir?: string;
  agentMemoryDir?: string;
}

function resolveMemoryDir(input: MemoryTokenLimitInput): string | null {
  const candidate =
    input.memoryDir || process.env.MEMORY_DIR || input.agentMemoryDir;
  return candidate ? resolve(candidate) : null;
}

function runGit(
  memoryDir: string,
  args: string[],
  allowPolicyUpdate = false,
): string {
  return execFileSync("git", args, {
    cwd: memoryDir,
    encoding: "utf8",
    env: allowPolicyUpdate
      ? { ...process.env, [MEMORY_TOKEN_LIMIT_UPDATE_ENV]: "1" }
      : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function printResult(
  limit: number,
  source: string,
  changed?: boolean,
  commit?: string,
): void {
  console.log(
    JSON.stringify(
      {
        ...(changed === undefined ? {} : { changed }),
        limit,
        source,
        ...(commit ? { commit } : {}),
      },
      null,
      2,
    ),
  );
}

export async function runMemoryTokenLimitAction(
  input: MemoryTokenLimitInput,
): Promise<number> {
  const memoryDir = resolveMemoryDir(input);
  if (!memoryDir) {
    console.error(
      "Missing memory dir. Pass --memory-dir, set MEMORY_DIR, or pass --agent.",
    );
    return USAGE_EXIT;
  }
  if (!existsSync(memoryDir)) {
    console.error(`Memory directory does not exist: ${memoryDir}`);
    return USAGE_EXIT;
  }

  const operation = input.operation ?? "get";
  if (operation === "get") {
    if (input.value !== undefined) {
      console.error("The get operation does not accept a value.");
      return USAGE_EXIT;
    }
    try {
      const policy = readMemoryTokenLimit(memoryDir);
      printResult(policy.limit, policy.source);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return IO_EXIT;
    }
  }

  if (operation !== "set") {
    console.error(`Unknown memory token-limit operation: ${operation}`);
    return USAGE_EXIT;
  }

  const limit = parsePositiveInteger(input.value);
  if (limit === null) {
    console.error("System prompt token limit must be a positive integer.");
    return USAGE_EXIT;
  }

  try {
    const estimate = estimateSystemPromptSize(memoryDir);
    if (estimate.total >= limit) {
      console.error(
        `System prompt is approximately ${estimate.total} tokens; the configured limit must be greater than the current estimate.`,
      );
      return USAGE_EXIT;
    }

    runGit(memoryDir, ["rev-parse", "--is-inside-work-tree"]);
    if (
      runGit(memoryDir, [
        "status",
        "--porcelain",
        "--",
        MEMORY_TOKEN_LIMIT_POLICY_PATH,
      ])
    ) {
      console.error(
        "The token-limit policy has uncommitted changes. Commit or discard them before changing the limit.",
      );
      return IO_EXIT;
    }

    const policyPath = join(memoryDir, MEMORY_TOKEN_LIMIT_POLICY_PATH);
    const policyExisted = existsSync(policyPath);
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, formatMemoryTokenLimit(limit), "utf8");
    runGit(memoryDir, ["add", "--", MEMORY_TOKEN_LIMIT_POLICY_PATH]);

    const staged = runGit(memoryDir, [
      "diff",
      "--cached",
      "--name-only",
      "--",
      MEMORY_TOKEN_LIMIT_POLICY_PATH,
    ]);
    if (!staged) {
      printResult(limit, MEMORY_TOKEN_LIMIT_POLICY_PATH, false);
      return 0;
    }

    try {
      runGit(
        memoryDir,
        [
          "commit",
          "-m",
          `config: set system prompt token limit to ${limit}`,
          "--",
          MEMORY_TOKEN_LIMIT_POLICY_PATH,
        ],
        true,
      );
    } catch (error) {
      try {
        runGit(memoryDir, [
          "reset",
          "HEAD",
          "--",
          MEMORY_TOKEN_LIMIT_POLICY_PATH,
        ]);
        if (policyExisted) {
          runGit(memoryDir, ["checkout", "--", MEMORY_TOKEN_LIMIT_POLICY_PATH]);
        } else {
          rmSync(policyPath, { force: true });
        }
      } catch {
        // Preserve the original commit error; cleanup is best-effort.
      }
      throw error;
    }

    printResult(
      limit,
      MEMORY_TOKEN_LIMIT_POLICY_PATH,
      true,
      runGit(memoryDir, ["rev-parse", "HEAD"]),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return IO_EXIT;
  }
}
