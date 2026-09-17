import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectMemoryFormat } from "@/agent/memory-format";
import { applyMemoryPatch } from "./memory-apply-patch";
import { validateRequiredParams } from "./validation";

interface ProposeMemoryPatchArgs {
  reason: string;
  input: string;
}

interface ProposeMemoryPatchResult {
  message: string;
}

function resolveWriterMemoryDir(): string {
  const direct = (
    process.env.LETTA_MEMORY_DIR ||
    process.env.MEMORY_DIR ||
    ""
  ).trim();
  if (!direct) {
    throw new Error(
      "propose_memory_patch: MEMORY_DIR is not set. This tool only runs inside a harness-owned memory-writer worktree.",
    );
  }
  return resolve(direct);
}

function ensureMemoryRepo(memoryDir: string): void {
  if (!existsSync(memoryDir)) {
    throw new Error(
      `propose_memory_patch: memory directory does not exist: ${memoryDir}`,
    );
  }
  if (!existsSync(resolve(memoryDir, ".git"))) {
    throw new Error(
      `propose_memory_patch: ${memoryDir} is not a git repository.`,
    );
  }
}

export async function propose_memory_patch(
  args: ProposeMemoryPatchArgs,
): Promise<ProposeMemoryPatchResult> {
  validateRequiredParams(args, ["reason", "input"], "propose_memory_patch");

  const reason = args.reason.trim();
  if (!reason) {
    throw new Error(
      "propose_memory_patch: 'reason' must be a non-empty string",
    );
  }

  const input = args.input;
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("propose_memory_patch: 'input' must be a non-empty string");
  }

  const memoryDir = resolveWriterMemoryDir();
  ensureMemoryRepo(memoryDir);

  const { getBackend } = await import("@/backend");
  const memoryFormat = detectMemoryFormat(
    memoryDir,
    getBackend().capabilities.localMemfs,
  );

  const pathspecs = await applyMemoryPatch(memoryDir, input, memoryFormat);
  if (pathspecs.length === 0) {
    throw new Error(
      "propose_memory_patch made no changes: the patch produced no changed paths.",
    );
  }

  return {
    message:
      `Drafted ${pathspecs.join(", ")} in the memory-writer worktree ` +
      `(${reason}). The harness will validate and commit; do not run git.`,
  };
}
